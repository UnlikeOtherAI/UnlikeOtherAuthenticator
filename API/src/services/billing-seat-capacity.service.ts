import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';
import { observedBillingTime } from './billing-seat-observed-time.service.js';

function client(deps?: { prisma?: PrismaClient }): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export async function listSeatSubscriptions(
  serviceId: string,
  deps?: { prisma?: PrismaClient; now?: () => Date },
) {
  const now = deps?.now?.() ?? await observedBillingTime(client(deps));
  const subscriptions = await client(deps).billingSeatSubscription.findMany({
    where: { serviceId },
    include: {
      org: { select: { id: true, name: true } },
      team: { select: { id: true, name: true } },
      capacityRevisions: { orderBy: { effectiveAt: 'desc' } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return subscriptions.map((subscription) => {
    const currentRevision = subscription.capacityRevisions.find(
      (revision) => revision.effectiveAt <= now,
    );
    return {
      id: subscription.id,
      service_id: subscription.serviceId,
      organisation: subscription.org,
      team: subscription.team,
      source: subscription.stripeSubscriptionId ? 'stripe' : 'manual',
      seat_policy: subscription.seatPolicy.toLowerCase(),
      seat_charge_timing: subscription.seatChargeTiming.toLowerCase(),
      baseline_member_count: subscription.baselineMemberCount,
      activated_at: subscription.activatedAt.toISOString(),
      ended_at: subscription.endedAt?.toISOString() ?? null,
      current_capacity: currentRevision?.quantity ?? null,
      capacity_revisions: subscription.capacityRevisions.map((revision) => ({
        id: revision.id, quantity: revision.quantity,
        effective_at: revision.effectiveAt.toISOString(),
      })),
    };
  });
}

export async function changeFixedSeatCapacity(
  input: { subscriptionId: string; quantity: number; actor: LifecycleActor },
  deps?: { prisma?: PrismaClient; now?: () => Date },
) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SEAT_CAPACITY');
  }
  return client(deps).$transaction(async (tx) => {
    // Recheck the token epoch and live superuser role at the final effect.
    const actorEmail = await requireLifecycleActor(tx as PrismaClient, input.actor);
    const scope = await tx.billingSeatSubscription.findUnique({
      where: { id: input.subscriptionId }, select: { orgId: true },
    });
    if (!scope) throw new AppError('NOT_FOUND', 404, 'SEAT_SUBSCRIPTION_NOT_FOUND');
    // Every roster, invitation and source writer takes this organisation lock
    // first. Taking the subscription lock first can deadlock those writers.
    await tx.$queryRaw`SELECT id FROM organisations WHERE id = ${scope.orgId} FOR UPDATE`;
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM billing_seat_subscriptions
      WHERE id = ${input.subscriptionId} FOR UPDATE
    `;
    if (!locked.length) throw new AppError('NOT_FOUND', 404, 'SEAT_SUBSCRIPTION_NOT_FOUND');
    // Financial effective time comes from the same clock as seat admission,
    // after contention has cleared rather than from a skewed application host.
    const now = deps?.now?.() ?? await observedBillingTime(tx);
    const subscription = await tx.billingSeatSubscription.findUniqueOrThrow({
      where: { id: input.subscriptionId },
      include: { capacityRevisions: { orderBy: { effectiveAt: 'desc' } } },
    });
    if (subscription.seatPolicy !== 'FIXED' || subscription.endedAt) {
      throw new AppError('BAD_REQUEST', 409, 'SEAT_CAPACITY_NOT_CHANGEABLE');
    }
    const current = subscription.capacityRevisions.find(
      (revision) => revision.effectiveAt <= now,
    );
    if (!current) throw new AppError('BAD_REQUEST', 409, 'SEAT_CAPACITY_RECONCILIATION_REQUIRED');
    if (subscription.capacityRevisions.some((revision) => revision.effectiveAt > now)) {
      throw new AppError('BAD_REQUEST', 409, 'SEAT_CAPACITY_CHANGE_PENDING');
    }
    if (current.quantity === input.quantity) {
      throw new AppError('BAD_REQUEST', 409, 'SEAT_CAPACITY_UNCHANGED');
    }
    const effectiveAt = subscription.seatChargeTiming === 'FULL_MONTH' &&
      input.quantity < current.quantity ? nextUtcMonth(now) : now;
    const revision = await tx.billingFixedSeatCapacityRevision.create({ data: {
      seatSubscriptionId: subscription.id, quantity: input.quantity, effectiveAt,
    } });
    await tx.adminAuditLog.create({ data: {
      actorEmail,
      action: 'billing.fixed_seat_capacity_changed',
      metadata: { seat_subscription_id: subscription.id, service_id: subscription.serviceId,
        organisation_id: subscription.orgId, team_id: subscription.teamId,
        previous_quantity: current.quantity, quantity: input.quantity,
        effective_at: effectiveAt.toISOString() },
    } });
    return { id: revision.id, quantity: revision.quantity,
      effective_at: revision.effectiveAt.toISOString() };
  });
}
