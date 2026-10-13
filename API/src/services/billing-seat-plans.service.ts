import { BillingTariffSource, type PrismaClient } from '@prisma/client';
import type { ProductEntitlementRequest, SeatPlansReadV1, SeatCheckoutRequestV1, SeatCheckoutResultV1 }
  from '@unlikeotherai/billing-statement-protocol';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { verifyBillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { commercialMember, lockCommercialAuthority } from './billing-product-authority.service.js';
import { compatibleStandardSeatTariff, requirePublishedSeatOffer } from './billing-seat-offer.service.js';
import { resolveBillingTariffForMonth, utcBillingMonth } from './billing-tariff-history.service.js';
import { privateCompanyPolicy } from './billing-product-private-policy.service.js';
import { effectiveTariffPayload } from './billing-entitlement.service.js';
import { createStripeCheckoutSession } from './billing-stripe-checkout.service.js';
import { billingLocale, type BillingCustomerLocale } from './billing-copy-locale.js';
import { seatConsent, SEAT_TERMS_VERSION } from './billing-seat-copy.catalog.js';
import { authorizeBillingCustomerAction, BILLING_CUSTOMER_ACTION } from './billing-customer-action-intent.service.js';

type Input<T> = { request: T; credential: VerifiedBillingAppKey; actorToken: string; locale?: BillingCustomerLocale };
export async function readSeatPlans(input: Input<ProductEntitlementRequest>, deps?: { prisma?: PrismaClient }): Promise<SeatPlansReadV1> {
  const { request, credential } = input;
  const actor = await verifyBillingActor({ token: input.actorToken, credential, endpoint: '/billing/v1/seats',
    request: { product: request.product, organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id } });
  return (deps?.prisma ?? getAdminPrisma()).$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential, product: request.product, organisationId: request.organisation_id, purpose: 'CUSTOMER_LIFECYCLE' });
    const manager = await commercialMember(tx, { organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id, tokenVersion: actor.tv });
    const base = { schema_version: 1 as const, product: request.product, organisation_id: request.organisation_id,
      subject: { team_id: request.team_id, user_id: request.user_id } };
    if (!manager) return { ...base, can_manage: false };
    const now = new Date();
    const [region, published, agreements, humans, current, pending, accepted] = await Promise.all([
      tx.billingOrganisationRegion.findUnique({ where: { orgId: request.organisation_id } }),
      tx.billingSeatOffer.findMany({ where: { serviceId: credential.service.id, withdrawnAt: null }, include: { tariff: true } }),
      tx.billingSeatSubscription.findMany({ where: { serviceId: credential.service.id, orgId: request.organisation_id,
        teamId: null, endedAt: null, OR: [{ commercialEndsAt: null }, { commercialEndsAt: { gt: now } }] },
      include: { capacityRevisions: { where: { effectiveAt: { lte: now } }, orderBy: { effectiveAt: 'desc' }, take: 1 } } }),
      tx.$queryRaw<Array<{ user_id: string }>>`SELECT user_id FROM billing_seat_eligible(${request.organisation_id}, NULL)`,
      resolveBillingTariffForMonth(tx, { serviceId: credential.service.id, organisationId: request.organisation_id,
        teamId: request.team_id, billingMonth: utcBillingMonth(now), at: now }),
      tx.billingStripeCheckoutSession.findFirst({ where: { serviceId: credential.service.id, orgId: request.organisation_id,
        usageTermsEffectiveAt: { gt: now } }, orderBy: { usageTermsEffectiveAt: 'asc' } }),
      tx.billingStripeCheckoutSession.findFirst({ where: { serviceId: credential.service.id, orgId: request.organisation_id,
        usageTermsEffectiveAt: { lte: now } }, orderBy: { usageTermsEffectiveAt: 'desc' } }),
    ]);
    const privatePlan = await privateCompanyPolicy(tx, credential.service.id, request.organisation_id, now);
    const offers = agreements.length || privatePlan ? [] : published.filter((offer) =>
      compatibleStandardSeatTariff(offer.tariff) && offer.tariff.currency === region?.currency).map((offer) => ({
      id: offer.id, name: 'Standard' as const, unit_amount_minor: offer.tariff.monthlyAmountMinor.toString(), currency: offer.tariff.currency,
      cadence: 'month' as const, charge_basis: 'per_human' as const, policy: 'automatic' as const, timing: 'prorated' as const,
      usage_currency: 'USD' as const, usage_payment_mode: 'prepaid' as const, usage_markup_bps: 3000 as const,
      terms_version: SEAT_TERMS_VERSION, consent_text: seatConsent(input.locale),
      action: { method: 'POST' as const, path: '/billing/v1/seats/checkout' as const,
        body: { ...request, offer_id: offer.id, terms_version: SEAT_TERMS_VERSION, accepted: true as const } },
    }));
    return { ...base, can_manage: true, state: agreements.length ? 'agreement_exists' : !region ? 'billing_region_required'
      : !offers.length ? 'catalog_required' : 'available', current_human_count: humans.length,
    agreements: agreements.map((row) => ({ id: row.id, policy: row.seatPolicy === 'FIXED' ? 'fixed' as const : 'automatic' as const,
      capacity: row.seatPolicy === 'FIXED' ? row.capacityRevisions[0]?.quantity ?? null : null,
      unit_amount_minor: row.unitAmountMinor.toString(), currency: row.currency,
      effective_at: row.commercialEffectiveAt.toISOString(), ends_at: row.commercialEndsAt?.toISOString() ?? null })),
    usage: { currency: current.tariff.usageCurrency, payment_mode: current.tariff.usagePaymentMode === 'PREPAID' ? 'prepaid' : 'pay_as_you_go',
      terms_collectible: current.tariff.mode !== 'FREE' && current.tariff.collectionMode !== 'NONE',
      effective_at: accepted?.usageTermsEffectiveAt?.toISOString() ?? null, pending_effective_at: pending?.usageTermsEffectiveAt?.toISOString() ?? null },
    offers, observed_at: now.toISOString(), valid_until: new Date(Math.min(now.getTime() + 60_000,
      pending?.usageTermsEffectiveAt?.getTime() ?? Infinity)).toISOString() };
  });
}

export async function checkoutSeatPlan(input: Input<SeatCheckoutRequestV1>, deps?: { prisma?: PrismaClient }): Promise<SeatCheckoutResultV1> {
  const { request, credential } = input;
  if (!request.accepted || request.terms_version !== SEAT_TERMS_VERSION) throw new AppError('BAD_REQUEST', 400, 'BILLING_SEAT_TERMS_REQUIRED');
  const actor = await verifyBillingActor({ token: input.actorToken, credential, endpoint: '/billing/v1/seats/checkout',
    request: { product: request.product, organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id } });
  const prisma = deps?.prisma ?? getAdminPrisma();
  const offer = await prisma.$transaction(async (tx) => {
    await lockCommercialAuthority(tx, { credential, product: request.product, organisationId: request.organisation_id, purpose: 'CUSTOMER_LIFECYCLE' });
    if (!await commercialMember(tx, { organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id, tokenVersion: actor.tv })) {
      throw new AppError('FORBIDDEN', 403, 'BILLING_COMPANY_MANAGER_REQUIRED');
    }
    if (await privateCompanyPolicy(tx, credential.service.id, request.organisation_id, new Date())) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_PRIVATE_POLICY_ASSIGNMENT_REQUIRED');
    }
    const selected = await requirePublishedSeatOffer(tx, credential.service.id, request.organisation_id, request.offer_id);
    await authorizeBillingCustomerAction({ credential, actor, organisationId: request.organisation_id, teamId: request.team_id,
      userId: request.user_id, authorityScope: 'ORGANISATION', operation: BILLING_CUSTOMER_ACTION.SEAT_CHECKOUT, request }, { prisma: tx });
    return selected;
  });
  const origin = credential.checkoutReturnOrigins[0];
  if (!origin) throw new AppError('BAD_REQUEST', 409, 'BILLING_SEAT_RETURN_ORIGIN_REQUIRED');
  const checkout = await createStripeCheckoutSession({ credential, actorToken: input.actorToken, endpoint: '/billing/v1/seats/checkout',
    locale: input.locale, selectedSeatOfferId: offer.id,
    selectedSeatConsent: { terms_version: SEAT_TERMS_VERSION, accepted: true, locale: billingLocale(input.locale),
      text: seatConsent(input.locale), unit_amount_minor: offer.tariff.monthlyAmountMinor.toString(), currency: offer.tariff.currency,
      usage_currency: offer.tariff.usageCurrency, usage_payment_mode: 'prepaid', usage_markup_bps: offer.tariff.markupBps,
      checkout_text: `${seatConsent(input.locale)} ${offer.tariff.currency} ` +
        `${offer.tariff.monthlyAmountMinor / 100n}.${(offer.tariff.monthlyAmountMinor % 100n).toString().padStart(2, '0')} / human / month.` },
    request: { product: request.product, organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id,
      successUrl: `${origin}/admin/billing`, cancelUrl: `${origin}/admin/billing` } },
  { prisma, resolveTariff: async () => ({ actor, payload: effectiveTariffPayload({ credential, tariff: offer.tariff,
    request: { product: request.product, organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id },
    assignment: { scope: BillingTariffSource.ORGANISATION, id: null }, nowEpochSeconds: Math.floor(Date.now() / 1000) }) }) });
  const url = new URL(checkout.checkout_url);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_SEAT_CHECKOUT_URL_INVALID');
  }
  return { schema_version: 1, product: request.product, organisation_id: request.organisation_id,
    checkout_id: checkout.checkout_session_id, state: 'open', url: url.toString(), expires_at: checkout.expires_at };
}
