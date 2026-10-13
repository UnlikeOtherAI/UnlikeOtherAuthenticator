import { BillingTariffSource, type Prisma, type BillingStripeCheckoutSession } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { compatibleStandardSeatTariff } from './billing-seat-offer.service.js';
import { nextUtcBillingMonth, utcBillingMonth } from './billing-tariff-history.service.js';
import { lockBudgetOrganisation } from './billing-credit-budget-dispatch.service.js';
export type FirstSeatUsageProof = { orgId: string; serviceId: string; checkedThroughMonth: string;
  checkedAt: Date; hasMetering: boolean };

/** Completion alone is insufficient: called only after exact active subscription validation. */
export async function activateAcceptedSeatUsage(tx: Prisma.TransactionClient,
  checkout: BillingStripeCheckoutSession, now: Date, proof?: FirstSeatUsageProof) {
  if (!checkout.seatOfferId || checkout.usageTermEventId) return;
  if (checkout.scope !== 'ORGANISATION' || checkout.teamId !== null || checkout.tariffSource !== 'ORGANISATION') {
    throw new AppError('INTERNAL', 409, 'BILLING_SEAT_ACCEPTANCE_SCOPE_INVALID');
  }
  await lockBudgetOrganisation(tx, checkout.orgId);
  await tx.$queryRaw`SELECT id FROM organisations WHERE id=${checkout.orgId} FOR UPDATE`;
  const fresh = await tx.billingStripeCheckoutSession.findUniqueOrThrow({ where: { id: checkout.id } });
  if (fresh.usageTermEventId) return;
  const offer = await tx.billingSeatOffer.findUnique({ where: { id: checkout.seatOfferId }, include: { tariff: true } });
  if (!offer || offer.tariffId !== checkout.tariffId || offer.serviceId !== checkout.serviceId ||
    !compatibleStandardSeatTariff(offer.tariff)) throw new AppError('INTERNAL', 409, 'BILLING_SEAT_ACCEPTANCE_TERMS_INVALID');
  // No current or historical company/team acceptance, admission, liability or
  // closed usage evidence may be retrospectively replaced by immediate terms.
  const [term, dispatch, liability, cycle, contract, priorCheckout] = await Promise.all([
    tx.billingTariffTermEvent.findFirst({ where: { serviceId: checkout.serviceId,
      OR: [{ source: 'ORGANISATION', scopeKey: checkout.orgId },
        { source: 'TEAM', scopeKey: { startsWith: `${checkout.orgId}:` } }] } }),
    tx.billingLedgerDispatchDecision.findFirst({ where: { serviceId: checkout.serviceId, orgId: checkout.orgId } }),
    tx.billingPaidUsageLiability.findFirst({ where: { serviceId: checkout.serviceId, orgId: checkout.orgId } }),
    tx.billingCustomerCycle.findFirst({ where: { serviceId: checkout.serviceId, orgId: checkout.orgId } }),
    tx.billingOrganisationContract.findFirst({ where: { orgId: checkout.orgId,
      versions: { some: { serviceTerms: { some: { serviceId: checkout.serviceId } } } } } }),
    tx.billingStripeCheckoutSession.findFirst({ where: { serviceId: checkout.serviceId, orgId: checkout.orgId,
      id: { not: checkout.id }, completedAt: { not: null } } }),
  ]);
  const candidate = !term && !dispatch && !liability && !cycle && !contract && !priorCheckout;
  if (candidate && (!proof || proof.orgId !== checkout.orgId || proof.serviceId !== checkout.serviceId ||
    (proof.checkedThroughMonth > utcBillingMonth(now) || (!proof.hasMetering && proof.checkedThroughMonth !== utcBillingMonth(now))) ||
    proof.checkedAt.getTime() > now.getTime() + 5000 ||
    now.getTime() - proof.checkedAt.getTime() > 60_000)) return;
  const first = candidate && proof?.hasMetering === false;
  const month = first ? utcBillingMonth(now) : nextUtcBillingMonth(now);
  const effectiveAt = first ? now : new Date(`${month}-01T00:00:00.000Z`);
  const event = await tx.billingTariffTermEvent.create({ data: {
    serviceId: checkout.serviceId, source: BillingTariffSource.ORGANISATION, scopeKey: checkout.orgId,
    effectiveFromMonth: month, prospectiveFrom: first ? now : null, tariffId: checkout.tariffId,
    reason: 'accepted-standard-company-seats',
  } });
  await tx.billingStripeCheckoutSession.update({ where: { id: checkout.id },
    data: { usageTermEventId: event.id, usageTermsEffectiveAt: effectiveAt } });
  await tx.orgAuditLog.create({ data: { orgId: checkout.orgId, actorUserId: checkout.requestedByUserId,
    action: 'billing.company_seat_agreement_accepted', targetType: 'billing_stripe_checkout', targetId: checkout.id,
    metadata: { service_id: checkout.serviceId, offer_id: offer.id, usage_effective_at: effectiveAt.toISOString(),
      seat_currency: offer.tariff.currency, usage_currency: offer.tariff.usageCurrency,
      first_usage_agreement: first, term_event_id: event.id } } });
}
