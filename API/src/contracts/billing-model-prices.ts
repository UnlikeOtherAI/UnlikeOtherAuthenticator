import { z } from 'zod';

const identifier = z.string().trim().min(1).max(256);
const rate = z.number().finite().nonnegative().max(100_000_000);
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/).max(48);

export const LedgerDisplayPriceCardSchema = z.object({
  currency: z.string().max(10), unit: z.string().max(60), basis: z.string().max(100),
  pricing_mode: z.enum(['fixed', 'subscription_included', 'provider_resolved']),
  input_price: rate.nullable().optional(), output_price: rate.nullable().optional(),
  cached_input_price: rate.nullable().optional(),
  updated_at: z.string().datetime(),
  pricing_dimensions: z.array(z.object({
    label: z.string().min(1).max(300), direction: z.enum(['input', 'output', 'unit']),
    usageUnit: z.string().max(60), unitPrice: rate, rateText: decimal.optional(),
    timeBand: z.enum(['peak', 'offpeak']).optional(),
    endpoint: z.string().max(150).optional(), serviceTier: z.string().max(100).optional(),
    region: z.string().max(100).optional(), contextMin: z.number().int().nonnegative().optional(),
    contextMax: z.number().int().nonnegative().optional(), requiresProviderReceipt: z.boolean().optional(),
    tariffEvidence: z.object({ contract: z.string(), sourceUrl: z.string().url(),
      sourceSha256: z.string(), capturedAt: z.string().datetime(), expiresAt: z.string().datetime() }).optional(),
  }).passthrough()).max(100).optional(),
});

export const BillingModelPricesRequestSchema = z.object({
  product: identifier, organisation_id: identifier, team_id: identifier, user_id: identifier,
  models: z.array(z.object({ provider: identifier, model: identifier, pricing: z.unknown() }).strict()).min(1).max(100),
}).strict();
export type BillingModelPricesRequest = z.infer<typeof BillingModelPricesRequestSchema>;

const creditRate = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/).nullable();
export const BillingModelPriceSchema = z.object({
  provider: identifier, model: identifier,
  status: z.enum(['available', 'unavailable']),
  reason: z.enum(['missing', 'invalid', 'currency', 'non_token', 'dynamic']).nullable(),
  input: creditRate, output: creditRate, cached_input: creditRate,
  updated_at: z.string().datetime().nullable(),
  dimensions: z.array(z.object({
    label: z.string(), direction: z.enum(['input', 'output', 'unit']),
    unit: z.string(), credits: creditRate, time_band: z.enum(['peak', 'offpeak']).nullable(),
    endpoint: z.string().nullable(), service_tier: z.string().nullable(), region: z.string().nullable(),
    context_min: z.number().nullable(), context_max: z.number().nullable(),
    requires_provider_receipt: z.boolean(), evidence_expires_at: z.string().datetime().nullable(),
  }).strict()),
}).strict();

export const BillingModelPricesResponseSchema = z.object({
  product: identifier, organisation_id: identifier, team_id: identifier, user_id: identifier,
  currency: z.literal('credits'), basis: z.literal('per_million_tokens'), advisory: z.literal(true),
  payment_collection_enabled: z.boolean(),
  issued_at: z.string().datetime(), expires_at: z.string().datetime(),
  models: z.array(BillingModelPriceSchema).max(100),
}).strict();
export type BillingModelPrice = z.infer<typeof BillingModelPriceSchema>;
