import type { PrismaClient } from '@prisma/client';
import { assertEntityAccess } from './entity-lifecycle.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { AppError } from '../utils/errors.js';

/** Hold lifecycle admission through a provider create. The callback performs
 * only the provider request, using already prepared immutable request data.
 * This prevents a checkout admitted earlier from appearing after an archive's
 * final provider scan. No database pool is checked out inside the callback.
 */
export async function withLiveTeamBillingEffect<T>(prisma: PrismaClient,
  scope: { organisationId: string; teamId: string | null }, effect: () => Promise<T>,
  onRefused?: () => Promise<unknown>): Promise<T> {
  try {
    return await prisma.$transaction(async tx => {
      await lockProductTeamPolicyShared(tx);
      try { await assertEntityAccess({ orgId: scope.organisationId,
        ...(scope.teamId===null?{}:{teamId:scope.teamId}) }, tx); }
      catch (error) {
        if (error instanceof AppError && error.statusCode === 403) throw new AppError('FORBIDDEN', 403, 'TEAM_BILLING_RETIRED');
        throw error;
      }
      return effect();
    }, { timeout: 90_000 });
  } catch (error) {
    if (error instanceof AppError && error.message === 'TEAM_BILLING_RETIRED') await onRefused?.();
    throw error;
  }
}

/** Scheduled collection may settle a suspended team's earned liabilities.
 * An archive explicitly stops billing, so it must also fence the jobs that
 * normally resume collection after an ordinary subscription cancellation.
 */
export async function withUnarchivedSubscriptionEffect<T>(prisma: PrismaClient,
  subscriptionId: string, effect: () => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await lockProductTeamPolicyShared(tx);
    await assertSubscriptionNotArchived(tx, subscriptionId);
    return effect();
  }, { timeout: 90_000 });
}

export async function assertSubscriptionNotArchived(
  prisma: Pick<PrismaClient, 'billingStripeSubscription' | 'team'>, subscriptionId: string,
): Promise<void> {
  const subscription = await prisma.billingStripeSubscription.findUniqueOrThrow({
    where: { id: subscriptionId }, select: { orgId: true, teamId: true },
  });
  if (!subscription.teamId) return;
  const team = await prisma.team.findUniqueOrThrow({ where: { id: subscription.teamId },
    select: { orgId: true, lifecycleStatus: true } });
  if (team.orgId !== subscription.orgId || team.lifecycleStatus === 'ARCHIVED') {
    throw new AppError('FORBIDDEN', 403, 'ARCHIVE_BILLING_COLLECTION_HELD');
  }
}
