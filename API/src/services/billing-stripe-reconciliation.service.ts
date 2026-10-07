import { BillingStripeMeterEventState, Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { stripeUsageMeterTimestamp } from './billing-stripe-usage-validation.service.js';

type Outcome = 'accepted' | 'not_accepted' | 'manual_invoice';
const ACTIVE_SEND_LEASE_MS = 10 * 60_000;

export async function listUncertainStripeUsageExports(
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const rows = await prisma.billingStripeUsageExport.findMany({
    where: { stripeMeterEventState: {
      in: [BillingStripeMeterEventState.UNCERTAIN, BillingStripeMeterEventState.RECONCILIATION_REQUIRED],
    } },
    orderBy: [{ stripeMeterEventAttemptedAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  return rows.map((row) => ({
    id: row.id,
    subscription_id: row.subscriptionId,
    billing_month: row.billingMonth,
    caller_product: row.callerProduct,
    currency: row.currency,
    delta_meter_quantity: row.deltaMeterQuantity.toString(),
    stripe_meter_event_identifier: row.stripeMeterEventIdentifier,
    delivery_state: row.stripeMeterEventState.toLowerCase(),
    attempted_at: row.stripeMeterEventAttemptedAt?.toISOString() ?? null,
  }));
}

/** A human must supply a Stripe event or invoice reference, or evidence of non-acceptance. */
export async function reconcileStripeUsageExport(
  params: {
    exportId: string;
    outcome: Outcome;
    evidenceReference: string;
    actorEmail: string;
    observedAt: Date;
    now?: Date;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = params.now ?? new Date();
  if (!params.evidenceReference.trim() || params.evidenceReference.length > 255 ||
      Number.isNaN(params.observedAt.getTime()) || params.observedAt > now) {
    throw new AppError('BAD_REQUEST', 400, 'STRIPE_METER_RECONCILIATION_EVIDENCE_INVALID');
  }
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "billing_stripe_usage_exports"
      WHERE "id" = ${params.exportId} FOR UPDATE
    `);
    if (locked.length !== 1) throw new AppError('NOT_FOUND', 404, 'STRIPE_USAGE_EXPORT_NOT_FOUND');
    const row = await tx.billingStripeUsageExport.findUniqueOrThrow({ where: { id: params.exportId } });
    if (row.stripeMeterEventState !== BillingStripeMeterEventState.UNCERTAIN &&
        row.stripeMeterEventState !== BillingStripeMeterEventState.RECONCILIATION_REQUIRED) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_METER_EVENT_RECONCILIATION_NOT_PENDING');
    }
    if (row.stripeMeterEventAttemptedAt && (
      params.observedAt < row.stripeMeterEventAttemptedAt ||
      now.getTime() - row.stripeMeterEventAttemptedAt.getTime() < ACTIVE_SEND_LEASE_MS
    )) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_METER_EVENT_SEND_STILL_ACTIVE');
    }
    if (params.outcome === 'not_accepted') {
      // The evidence releases exactly one retry. Outside Stripe's timestamp
      // window, the operator must reconcile through an invoice adjustment.
      stripeUsageMeterTimestamp(row.createdAt, row.billingMonth, now);
    }
    if (params.outcome === 'manual_invoice' && !/^in_[A-Za-z0-9_]+$/.test(params.evidenceReference)) {
      throw new AppError('BAD_REQUEST', 400, 'STRIPE_METER_RECONCILIATION_EVIDENCE_INVALID');
    }
    if (params.outcome === 'not_accepted' && row.stripeMeterEventAttemptGeneration >= 999) {
      throw new AppError('BAD_REQUEST', 409, 'STRIPE_METER_RETRY_GENERATIONS_EXHAUSTED');
    }
    const state = params.outcome === 'accepted'
      ? BillingStripeMeterEventState.ACCEPTED
      : params.outcome === 'manual_invoice'
        ? BillingStripeMeterEventState.MANUAL_SETTLED
        : BillingStripeMeterEventState.PENDING;
    await tx.billingStripeUsageReconciliation.create({
      data: {
        exportId: row.id,
        outcome: params.outcome,
        evidenceReference: params.evidenceReference,
        priorEventIdentifier: row.stripeMeterEventIdentifier,
        priorAttemptGeneration: row.stripeMeterEventAttemptGeneration,
        actorEmail: params.actorEmail,
        observedAt: params.observedAt,
      },
    });
    await tx.billingStripeUsageExport.update({
      where: { id: row.id },
      data: {
        stripeMeterEventState: state,
        stripeMeterEventCreatedAt: params.outcome === 'accepted' ? params.observedAt : null,
        stripeMeterEventAttemptedAt: params.outcome === 'not_accepted' ? null : row.stripeMeterEventAttemptedAt,
        stripeMeterEventFirstAttemptedAt: params.outcome === 'not_accepted'
          ? null : row.stripeMeterEventFirstAttemptedAt,
        ...(params.outcome === 'not_accepted' ? {
          stripeMeterEventAttemptGeneration: row.stripeMeterEventAttemptGeneration + 1,
          stripeMeterEventIdentifier: `${row.stripeMeterEventIdentifier.replace(/_r\d+$/, '')}_r${row.stripeMeterEventAttemptGeneration + 1}`,
        } : {}),
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actorEmail,
        action: 'billing.stripe_meter_reconciled',
        metadata: {
          export_id: row.id,
          subscription_id: row.subscriptionId,
          billing_month: row.billingMonth,
          stripe_meter_event_identifier: row.stripeMeterEventIdentifier,
          prior_attempt_generation: row.stripeMeterEventAttemptGeneration,
          outcome: params.outcome,
          evidence_reference: params.evidenceReference,
        },
      },
    });
    return { export_id: row.id, delivery_state: state.toLowerCase() };
  });
}
