import {
  BillingMonthlyChargeBasis, BillingSeatPolicy, type Prisma,
} from '@prisma/client';
import type Stripe from 'stripe';

import { AppError } from '../utils/errors.js';

type FrozenStripeSeatSource = {
  id: string;
  serviceId: string;
  tariffId: string;
  orgId: string;
  teamId: string | null;
  scope: 'TEAM' | 'ORGANISATION';
  billableFrom: Date | null;
  billableUntil: Date | null;
};

type FrozenStripeSeatTariff = {
  monthlyChargeBasis: BillingMonthlyChargeBasis;
  seatPolicy: BillingSeatPolicy | null;
  seatChargeTiming: 'FULL_MONTH' | 'PRORATED' | null;
  monthlyAmountMinor: bigint;
  currency: string;
};

function terminal(status: string): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

function observedTerminalAt(subscription: Stripe.Subscription, observedAt: Date): Date {
  const endedAt = subscription.ended_at;
  if (endedAt === null || !Number.isSafeInteger(endedAt) || endedAt <= 0) return observedAt;
  const timestamp = new Date(endedAt * 1000);
  if (timestamp > observedAt) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SUBSCRIPTION_END_INVALID');
  }
  return timestamp;
}

/** Records first observed paid scope and terminal boundaries exactly once. */
export async function syncStripeSeatActivation(
  tx: Prisma.TransactionClient,
  params: {
    row: FrozenStripeSeatSource;
    tariff: FrozenStripeSeatTariff;
    checkoutFixedSeatQuantity: number | null;
    subscription: Stripe.Subscription;
    observedAt: Date;
  },
): Promise<void> {
  const { row, tariff, subscription, observedAt } = params;
  const active = subscription.status === 'active' || subscription.status === 'trialing';
  const ending = terminal(subscription.status);
  if (active && row.billableFrom === null) {
    await tx.billingStripeSubscription.update({ where: { id: row.id },
      data: { billableFrom: observedAt } });
  }
  if (ending && row.billableFrom !== null && row.billableUntil === null) {
    const endedAt = observedTerminalAt(subscription, observedAt);
    if (endedAt <= row.billableFrom) {
      throw new AppError('INTERNAL', 409, 'STRIPE_SUBSCRIPTION_END_UNRESOLVED');
    }
    await tx.billingStripeSubscription.update({ where: { id: row.id },
      data: { billableUntil: endedAt } });
  }
  if (tariff.monthlyChargeBasis !== BillingMonthlyChargeBasis.PER_SEAT) return;
  if (!tariff.seatPolicy || !tariff.seatChargeTiming) {
    throw new AppError('INTERNAL', 502, 'STRIPE_SEAT_TERMS_INVALID');
  }
  const existing = await tx.billingSeatSubscription.findUnique({
    where: { stripeSubscriptionId: row.id },
  });
  if (!existing && active) {
    const created = await tx.billingSeatSubscription.create({ data: {
      stripeSubscriptionId: row.id, serviceId: row.serviceId, tariffId: row.tariffId,
      orgId: row.orgId, teamId: row.teamId, scope: row.scope,
      seatPolicy: tariff.seatPolicy, seatChargeTiming: tariff.seatChargeTiming,
      unitAmountMinor: tariff.monthlyAmountMinor, currency: tariff.currency,
      activatedAt: observedAt, baselineCapturedAt: observedAt,
      commercialEffectiveAt: observedAt,
    } });
    if (tariff.seatPolicy === BillingSeatPolicy.FIXED) {
      if (!params.checkoutFixedSeatQuantity) {
        throw new AppError('INTERNAL', 502, 'STRIPE_SEAT_QUANTITY_BINDING_INVALID');
      }
      await tx.billingFixedSeatCapacityRevision.create({ data: {
        seatSubscriptionId: created.id, quantity: params.checkoutFixedSeatQuantity,
        effectiveAt: observedAt,
      } });
    }
  }
  if (existing && ending && existing.endedAt === null) {
    const sourceEndedAt = observedTerminalAt(subscription, observedAt);
    await tx.billingSeatSubscription.update({ where: { id: existing.id }, data: {
      endedAt: observedAt,
      ...(sourceEndedAt > existing.commercialEffectiveAt
        ? { commercialEndsAt: sourceEndedAt } : {}),
    } });
  }
}
