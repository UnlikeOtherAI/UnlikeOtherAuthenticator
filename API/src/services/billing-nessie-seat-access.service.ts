import type { Prisma } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { resolveCurrentBillingTariff } from './billing-current-tariff.service.js';
import { nessieSeatTransition } from './billing-nessie-seat-transition.service.js';
import { resolveTeamBillingMode } from './billing-team-mode.service.js';
import { utcBillingMonth } from './billing-tariff-history.service.js';

export type NessieSeatAccess = {
  allowed: boolean;
  status: 'paid' | 'agreement' | 'transition' | 'renewal_grace' | 'payment_required';
  deadline: string | null;
  reason: 'setup_required' | 'transition_ended' | 'payment_required' | 'payment_action_required' | 'card_expired' | null;
};
const hold = (reason: NessieSeatAccess['reason'], deadline: Date | null = null): NessieSeatAccess => ({
  allowed: false, status: 'payment_required', deadline: deadline?.toISOString() ?? null, reason,
});

/** Current financial evidence, shared by the product access projection and paid dispatch gates. */
export async function readNessieSeatAccess(tx: Prisma.TransactionClient, scope: {
  serviceId: string; organisationId: string; teamId: string | null; userId?: string;
}, now = new Date(), intent: 'projection' | 'admission' = 'admission'): Promise<NessieSeatAccess> {
  const effective = await resolveCurrentBillingTariff(tx, { ...scope, asOf: now, billingMonth: utcBillingMonth(now) }, 'nessie');
  if (!effective.tariff.anniversarySeats) return effective.source === 'SERVICE_DEFAULT' ? hold('setup_required')
    : { allowed: true, status: 'agreement', deadline: null, reason: null };
  const teamId = effective.source === 'TEAM' ? scope.teamId : null;
  const mode = await resolveTeamBillingMode(scope, tx);
  const env = getEnv();
  const accountId = mode.mode === 'live' ? env.STRIPE_LIVE_ACCOUNT_ID : env.STRIPE_SANDBOX_ACCOUNT_ID;
  const subscriptions = accountId ? await tx.billingStripeSubscription.findMany({ where: {
    serviceId: scope.serviceId, orgId: scope.organisationId, teamId,
    account: { stripeAccountId: accountId, livemode: mode.mode === 'live' },
  }, include: {
    seatRenewals: { where: { recoveredAt: null }, orderBy: { graceEndsAt: 'asc' }, take: 1 },
  } }) : [];
  const active = subscriptions.filter(sub => !['canceled', 'incomplete_expired'].includes(sub.status));
  if (active.length > 1) throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SEAT_SUBSCRIPTION_AMBIGUOUS');
  const current = active[0];
  if (current?.tariffId === effective.tariff.id && current.initialSeatInvoiceId) {
    const failure = current.seatRenewals[0];
    if (failure) return failure.graceEndsAt > now
      ? { allowed: true, status: 'renewal_grace', deadline: failure.graceEndsAt.toISOString(),
        reason: failure.reason as NessieSeatAccess['reason'] }
      : hold(failure.reason as NessieSeatAccess['reason'], failure.graceEndsAt);
    const collected = await tx.$queryRaw<Array<{ paid: boolean }>>`
      SELECT billing_nessie_subscription_paid_now(${current.id},${now}) AS paid`;
    if (collected[0]?.paid === true) {
      return { allowed: true, status: 'paid', deadline: null, reason: null };
    }
    return hold('payment_required');
  }
  // A cancelled, changed or unpaid existing subscription never awards a fresh trial.
  if (subscriptions.length || await tx.billingStripeSubscription.count({ where: {
    serviceId: scope.serviceId, orgId: scope.organisationId, teamId,
  } })) return hold('payment_required');
  const transition = await nessieSeatTransition(tx, scope.organisationId, intent);
  if (!transition) return hold('setup_required');
  if (!transition.endedAt && transition.endsAt > now &&
    (scope.userId === undefined || transition.cohortUserIds.includes(scope.userId))) {
    return { allowed: true, status: 'transition', deadline: transition.endsAt.toISOString(), reason: 'setup_required' };
  }
  return hold('transition_ended', transition.endedAt ?? transition.endsAt);
}

export async function assertNessieSeatUsage(tx: Prisma.TransactionClient, scope: {
  product: string; serviceId: string; organisationId: string; teamId: string | null; userId?: string;
}): Promise<void> {
  if (scope.product !== 'nessie') return;
  if (!(await readNessieSeatAccess(tx, scope)).allowed) {
    throw new AppError('FORBIDDEN', 402, 'BILLING_SEAT_PAYMENT_REQUIRED');
  }
}
