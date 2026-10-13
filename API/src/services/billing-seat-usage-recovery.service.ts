import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import { fetchVerifiedLedgerBudgetReceiptSet } from './billing-ledger-paid-receipt-proof.service.js';
import { activateAcceptedSeatUsage } from './billing-seat-acceptance.service.js';
import { nextUtcBillingMonth, utcBillingMonth } from './billing-tariff-history.service.js';
import { meteringIsComplete } from './billing-metering.types.js';
import { lockBudgetOrganisation } from './billing-credit-budget-dispatch.service.js';

/** One historical month per durable claim; no network calls under company locks. */
export async function recoverAcceptedSeatUsage(prisma: PrismaClient, deps?: {
  fetchMetering?: typeof fetchLedgerMeteringUsage; fetchProof?: typeof fetchVerifiedLedgerBudgetReceiptSet; now?: () => Date;
}) {
  const now = deps?.now?.() ?? new Date();
  const jobs = await prisma.billingStripeCheckoutSession.findMany({ where: { seatOfferId: { not: null },
    usageTermEventId: null, usageProbeNextAttemptAt: { lte: now }, subscription: { status: 'active' } },
  orderBy: [{ usageProbeNextAttemptAt: 'asc' }, { id: 'asc' }], take: 5, include: { org: true, service: true } });
  for (const job of jobs) {
    const claim = await prisma.billingStripeCheckoutSession.updateMany({ where: { id: job.id, usageTermEventId: null,
      usageProbeNextAttemptAt: { lte: now } }, data: { usageProbeNextAttemptAt: new Date(now.getTime() + 60_000) } });
    if (!claim.count) continue;
    try {
      const month = job.usageProbeMonth ?? utcBillingMonth(job.org.createdAt);
      const [metering, proof] = await Promise.all([
        (deps?.fetchMetering ?? fetchLedgerMeteringUsage)({ product: job.service.identifier, organisationId: job.orgId,
          teamId: null, billingMonth: month, groupBy: 'service' }),
        (deps?.fetchProof ?? fetchVerifiedLedgerBudgetReceiptSet)({ product: job.service.identifier,
          organisationId: job.orgId, teamId: null, budgetScopeType: 'organization', billingMonth: month }),
      ]);
      const checkedAt = deps?.now?.() ?? new Date();
      const recent = (value: string) => Date.parse(value) <= checkedAt.getTime() + 5000 && checkedAt.getTime() - Date.parse(value) <= 60_000;
      if (!meteringIsComplete(metering.billingCompleteness) || !recent(metering.snapshot.capturedAt) || !recent(proof.snapshot.captured_at) ||
        metering.product !== job.service.identifier || metering.scope.organizationId !== job.orgId || metering.scope.teamId !== null ||
        metering.scope.month !== month || proof.scope.billing_product !== job.service.identifier || proof.scope.organization_id !== job.orgId ||
        proof.scope.team_id !== null || proof.scope.billing_month !== month || proof.scope.budget_scope_type !== 'organization' ||
        proof.unresolved_paid_attempts !== '0' || proof.pending_dispatch_count !== '0') {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_FIRST_USAGE_SOURCE_RECONCILIATION_REQUIRED');
      }
      const hasMetering = metering.calls !== '0' || metering.lines.some((line) => line.calls !== '0' ||
        (line.selectedProviderCost !== null && !new Prisma.Decimal(line.selectedProviderCost).isZero())) ||
        proof.paid_receipt_count !== '0' || proof.zero_incremental_count !== '0';
      if (!hasMetering && (proof.paid_receipt_sha256 !== createHash('sha256').update('ledger-budget-receipt-set-v1:paid\n').digest('hex') ||
        proof.zero_incremental_sha256 !== createHash('sha256').update('ledger-budget-receipt-set-v1:zero\n').digest('hex') ||
        proof.pending_dispatch_sha256 !== createHash('sha256').update('ledger-budget-receipt-set-v1:pending\n').digest('hex'))) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_FIRST_USAGE_ZERO_PROOF_INCOHERENT');
      }
      await prisma.$transaction(async (tx) => {
        await lockBudgetOrganisation(tx, job.orgId);
        await tx.$queryRaw`SELECT id FROM organisations WHERE id=${job.orgId} FOR UPDATE`;
        const fresh = await tx.billingStripeCheckoutSession.findUniqueOrThrow({ where: { id: job.id } });
        if (fresh.usageTermEventId || fresh.usageProbeMonth !== job.usageProbeMonth) return;
        const subscription = await tx.billingStripeSubscription.findUnique({ where: { checkoutId: job.id } });
        if (subscription?.status !== 'active') return;
        const evidence = { month, has_metering: hasMetering, checked_at: checkedAt.toISOString(),
          metering_snapshot: metering.snapshot, signed_receipt_set: proof };
        const previous = Array.isArray(fresh.usageProbeEvidence) ? fresh.usageProbeEvidence : [];
        await tx.billingStripeCheckoutSession.update({ where: { id: job.id }, data: {
          usageProbeEvidence: [...previous, evidence], usageProbeMonth: hasMetering || month >= utcBillingMonth(checkedAt) ? month
            : nextUtcBillingMonth(new Date(`${month}-01T00:00:00Z`)),
        } });
        if (hasMetering || month === utcBillingMonth(checkedAt)) await activateAcceptedSeatUsage(tx, fresh, checkedAt, {
          serviceId: job.serviceId, orgId: job.orgId, checkedThroughMonth: month, checkedAt, hasMetering,
        });
      });
    } catch {
      // The committed claim retries this exact month, preserving paid seats and
      // existing usage authority. Missing source proof is never a payment failure.
    }
  }
}
