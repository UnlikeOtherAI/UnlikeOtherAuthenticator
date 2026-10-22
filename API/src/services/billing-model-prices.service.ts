import { BillingTariffMode, Prisma, type PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { LedgerDisplayPriceCardSchema, type BillingModelPrice,
  type BillingModelPricesRequest } from '../contracts/billing-model-prices.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { resolveEffectiveTariffContext } from './billing-entitlement.service.js';
import { maximumRatedMicrocredits } from './billing-paid-liability.service.js';
import { billingCreditAmount } from './billing-credit-display.service.js';

type Tariff = { mode: BillingTariffMode; markupBps: number };

/** Display estimates only. These cards can never reserve funds or settle usage. */
export function modelDisplayPrice(entry: BillingModelPricesRequest['models'][number], tariff: Tariff): BillingModelPrice {
  const empty: BillingModelPrice = { provider: entry.provider, model: entry.model, status: 'unavailable',
    reason: 'missing', input: null, output: null, cached_input: null, updated_at: null, dimensions: [] };
  if (entry.pricing == null) return empty;
  const parsed = LedgerDisplayPriceCardSchema.safeParse(entry.pricing);
  if (!parsed.success) return { ...empty, reason: 'invalid' };
  const card = parsed.data;
  const missing = { ...empty, updated_at: card.updated_at };
  if (card.pricing_mode !== 'fixed') return { ...missing, reason: 'dynamic' };
  if (card.unit !== 'tokens' || card.basis !== 'per 1M tokens') return { ...missing, reason: 'non_token' };
  // Provider currencies without an independently supported settlement FX rate
  // stay unknown. Monthly subscription currency is not the usage currency.
  if (card.currency !== 'USD') return { ...missing, reason: 'currency' };
  const credits = (value: number | string | null | undefined): string | null => {
    if (value == null) return null;
    if (tariff.mode === BillingTariffMode.FREE) return '0';
    return billingCreditAmount(maximumRatedMicrocredits(new Prisma.Decimal(value), tariff.markupBps)).credits;
  };
  const dimensions = (card.pricing_dimensions ?? []).map((item) => ({
    label: item.label, direction: item.direction, unit: item.usageUnit,
    credits: ['tokens', 'cached_tokens'].includes(item.usageUnit) ? credits(item.rateText ?? item.unitPrice) : null,
    time_band: item.timeBand ?? null, endpoint: item.endpoint ?? null, service_tier: item.serviceTier ?? null,
    region: item.region ?? null, context_min: item.contextMin ?? null, context_max: item.contextMax ?? null,
    requires_provider_receipt: item.requiresProviderReceipt ?? false,
    evidence_expires_at: item.tariffEvidence?.expiresAt ?? null,
  }));
  const input = credits(card.input_price);
  const output = credits(card.output_price);
  const cached = credits(card.cached_input_price);
  const available = input !== null || output !== null || cached !== null || dimensions.some((item) => item.credits !== null);
  return { ...missing, status: available ? 'available' : 'unavailable', reason: available ? null : 'missing',
    input, output, cached_input: cached, dimensions };
}

export async function getModelDisplayPrices(input: {
  request: BillingModelPricesRequest; actorToken: string; credential: VerifiedBillingAppKey;
}, deps?: { prisma?: PrismaClient; now?: () => number }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { request } = input;
  const { payload } = await resolveEffectiveTariffContext({ ...input,
    endpoint: '/billing/v1/model-prices', request: { product: request.product,
      organisationId: request.organisation_id, teamId: request.team_id, userId: request.user_id } }, deps);
  // The canonical resolver already selected this immutable monthly tariff,
  // including negotiated contracts. Private terms never leave this service.
  const tariff = await prisma.billingTariff.findUnique({ where: { id: payload.tariff.id },
    select: { mode: true, markupBps: true } });
  if (!tariff) throw new AppError('INTERNAL', 503, 'BILLING_MODEL_PRICES_UNAVAILABLE');
  return { product: request.product, organisation_id: request.organisation_id,
    team_id: request.team_id, user_id: request.user_id, currency: 'credits' as const,
    basis: 'per_million_tokens' as const, advisory: true as const,
    issued_at: payload.issued_at, expires_at: payload.expires_at,
    models: request.models.map((entry) => modelDisplayPrice(entry, tariff)) };
}
