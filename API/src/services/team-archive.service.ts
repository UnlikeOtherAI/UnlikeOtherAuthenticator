import { Prisma, type PrismaClient, type TeamArchiveOperation } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { AccessTokenClaims } from './access-token.service.js';
import type { ClientConfig } from './config.service.js';
import { verifyDomainAuthToken } from './domain-secret.service.js';
import { assertEntityAccess } from './entity-lifecycle.service.js';
import { runEnterpriseAuthorityTransaction } from './enterprise-authority-transaction.service.js';
import { revokeLifecycleSessions } from './internal-admin-lifecycle.service.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { requireTeamCapability } from './team.service.base.js';
import { disabledAutoTopUpState } from './billing-credit-auto-top-up-disabled-state.js';
import { observedBillingTime } from './billing-seat-observed-time.service.js';

export function teamArchiveReceipt(row: TeamArchiveOperation) {
  return { id: row.id, organisation_id: row.orgId, team_id: row.teamId,
    status: row.billingStoppedAt ? 'ARCHIVED' as const : 'STOPPING_BILLING' as const,
    access_stopped: true, billing_stopped: Boolean(row.billingStoppedAt),
    deletion_held: true, permanently_deleted: false,
    archived_at: row.createdAt.toISOString(), billing_stopped_at: row.billingStoppedAt?.toISOString() ?? null };
}

/** Wait for already admitted provider calls to settle before certifying a stop.
 * The persisted claims cover response-loss recovery too; no new claim can pass
 * the exclusive policy fence after the lifecycle transition commits.
 */
async function providerSettleAfter(tx: PrismaClient, teamId: string, observedAt: Date): Promise<Date> {
  let deadline = observedAt.getTime();
  if (await tx.billingStripeCustomer.findFirst({ where: { teamId, scope: 'TEAM', stripeCustomerId: { not: null } },
    select: { id: true } })) deadline += 90_000;
  for (const model of Prisma.dmmf.datamodel.models.filter(model => model.name.startsWith('Billing') &&
    model.fields.some(field => ['leaseExpiresAt', 'invoiceLeaseExpiresAt'].includes(field.name)) &&
    model.fields.some(field => ['teamId', 'customerId', 'subscriptionId', 'closeId'].includes(field.name)))) {
    const column = ['teamId', 'customerId', 'subscriptionId', 'closeId']
      .map(name => model.fields.find(field => field.name === name)).find(Boolean);
    if (!column) throw new Error('ARCHIVE_PROVIDER_SCOPE_UNAVAILABLE');
    const field = Prisma.raw(`"${column.dbName ?? column.name}"`);
    const scope = column.name === 'teamId' ? Prisma.sql`${field} = ${teamId}`
      : column.name === 'customerId' ? Prisma.sql`${field} IN
          (SELECT id FROM billing_stripe_customers WHERE team_id=${teamId} AND scope::text='TEAM')`
      : column.name === 'subscriptionId' ? Prisma.sql`${field} IN
          (SELECT id FROM billing_stripe_subscriptions WHERE team_id=${teamId})`
      : Prisma.sql`${field} IN (SELECT c.id FROM billing_stripe_invoice_closes c
          JOIN billing_stripe_subscriptions s ON s.id=c.subscription_id WHERE s.team_id=${teamId})`;
    for (const lease of model.fields.filter(field => ['leaseExpiresAt', 'invoiceLeaseExpiresAt'].includes(field.name))) {
      const rows = await tx.$queryRaw<Array<{ deadline: Date | null }>>(Prisma.sql`
        SELECT max(${Prisma.raw(`"${lease.dbName}"`)}) AS deadline
        FROM ${Prisma.raw(`"${model.dbName}"`)} WHERE ${scope}`);
      if (rows[0]?.deadline) deadline = Math.max(deadline, rows[0].deadline.getTime() + 90_000);
    }
  }
  const attempt = await tx.billingCreditAutoTopUpAttempt.findFirst({ where: {
    creditAccount: { teamId }, status: { in: ['PENDING', 'PROCESSING', 'REQUIRES_ACTION', 'NEEDS_REVIEW'] },
  }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (attempt) deadline = Math.max(deadline, attempt.createdAt.getTime() + 180_000);
  return new Date(deadline);
}

export async function beginTeamArchive(params: {
  id: string; orgId: string; teamId: string; claims: AccessTokenClaims;
  config: ClientConfig; domain: string; domainToken: string;
}, deps?: { prisma?: PrismaClient }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  return runEnterpriseAuthorityTransaction(prisma, async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const authority = await verifyDomainAuthToken({ domain: params.domain, token: params.domainToken }, { prisma: tx });
    const previous = await tx.teamArchiveOperation.findUnique({ where: { id: params.id } });
    if (previous) {
      if (previous.teamId !== params.teamId || previous.orgId !== params.orgId ||
        previous.actorUserId !== params.claims.userId || previous.sourceClientDomainId !== authority.clientDomainId) {
        throw new AppError('BAD_REQUEST', 409, 'ARCHIVE_RETRY_MISMATCH');
      }
      return teamArchiveReceipt(previous);
    }
    if (params.claims.domain !== params.domain || params.claims.org?.org_id !== params.orgId ||
      params.claims.active?.teamId !== params.teamId || params.claims.active.orgId !== params.orgId) {
      throw new AppError('FORBIDDEN', 403);
    }
    const members = await tx.teamMember.findMany({ where: { teamId: params.teamId }, select: { userId: true } });
    for (const userId of [...new Set([params.claims.userId, ...members.map(member => member.userId)])].sort()) {
      await lockRefreshSessionUser(userId, { prisma: tx });
    }
    await tx.$queryRaw`SELECT id FROM organisations WHERE id=${params.orgId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM teams WHERE id=${params.teamId} AND org_id=${params.orgId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: params.claims.userId }, select: { tokenVersion: true } });
    if (!user || user.tokenVersion !== params.claims.tokenVersion) throw new AppError('UNAUTHORIZED', 401);
    if (params.claims.assuranceId && !await tx.sessionAssurance.findFirst({ where: {
      id: params.claims.assuranceId, userId: params.claims.userId, clientDomain: params.domain,
      orgId: params.orgId, teamId: params.teamId, credentialEpoch: params.claims.tokenVersion,
      revokedAt: null, expiresAt: { gt: new Date() },
    } })) throw new AppError('UNAUTHORIZED', 401);
    await assertEntityAccess({ userId: params.claims.userId, orgId: params.orgId, teamId: params.teamId }, tx);
    await requireTeamCapability(tx, 'teams.manage', {
      orgId: params.orgId, actorUserId: params.claims.userId, config: params.config,
    });
    if (!await tx.teamMember.findFirst({ where: { teamId: params.teamId,
      userId: params.claims.userId, status: 'ACTIVE' } })) throw new AppError('FORBIDDEN', 403);
    const now = await observedBillingTime(tx);
    const operation = await tx.teamArchiveOperation.create({ data: {
      id: params.id, orgId: params.orgId, teamId: params.teamId,
      sourceClientDomainId: authority.clientDomainId, actorUserId: params.claims.userId,
      createdAt: now,
      settleAfter: await providerSettleAfter(tx, params.teamId, now),
    } });
    await tx.team.update({ where: { id: params.teamId }, data: {
      lifecycleStatus: 'ARCHIVED', lifecycleChangedAt: now,
      lifecycleReason: 'Team archived by an organisation owner or admin.',
    } });
    await revokeLifecycleSessions(tx, 'TEAM', params.teamId);
    await tx.billingCreditSetupCheckout.updateMany({ where: {
      creditAccount: { teamId: params.teamId, scope: 'TEAM' }, status: { in: ['CREATING', 'OPEN', 'NEEDS_REVIEW'] },
    }, data: { status: 'ABANDONED' } });
    await tx.billingCreditAccount.updateMany({ where: {
      teamId: params.teamId, scope: 'TEAM', autoTopUpState: { not: 'DISABLED' },
    }, data: disabledAutoTopUpState() });
    const seats = await tx.billingSeatSubscription.findMany({ where: { teamId: params.teamId, endedAt: null },
      select: { id: true, commercialEndsAt: true, commercialEffectiveAt: true } });
    for (const seat of seats) await tx.billingSeatSubscription.update({ where: { id: seat.id }, data: {
      endedAt: now,
      ...(!seat.commercialEndsAt && now > seat.commercialEffectiveAt ? { commercialEndsAt: now } : {}),
    } });
    // Canonical roster triggers close membership evidence at the observed end.
    await tx.orgAuditLog.create({ data: { orgId: params.orgId, actorUserId: params.claims.userId,
      action: 'team.archived_deletion_held', targetType: 'team', targetId: params.teamId,
      metadata: { operationId: operation.id, scope: 'all_products', deletionHeld: true } } });
    return teamArchiveReceipt(operation);
  });
}

/** Recovery grants no membership or content access and is bound to the initiating product. */
export async function readTeamArchive(id: string, clientDomainId: string, prisma = getAdminPrisma()) {
  const row = await prisma.teamArchiveOperation.findFirst({ where: { id, sourceClientDomainId: clientDomainId } });
  if (!row) throw new AppError('NOT_FOUND', 404);
  return teamArchiveReceipt(row);
}
