import { BillingTariffMode } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { BillingModelPricesRequestSchema, BillingModelPriceSchema } from '../../src/contracts/billing-model-prices.js';
import { modelDisplayPrice } from '../../src/services/billing-model-prices.service.js';

const card = { currency: 'USD', unit: 'tokens', basis: 'per 1M tokens', pricing_mode: 'fixed',
  input_price: 0.25, output_price: 2, cached_input_price: 0, updated_at: '2026-10-22T12:00:00.000Z' };
const entry = (pricing: unknown) => ({ provider: 'openai', model: 'example', pricing });
const standard = { mode: BillingTariffMode.STANDARD, markupBps: 3000 };

describe('customer model price estimates', () => {
  it('uses the existing USD liability quantum: 1,000 credits/USD and exactly one markup', () => {
    const result = modelDisplayPrice(entry(card), standard);
    expect(result).toMatchObject({ input: '325', output: '2600', cached_input: '0', status: 'available' });
    expect(BillingModelPriceSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/markup|tariff_id|input_price|USD/);
  });

  it('honours at-cost, custom and free tariffs rather than assuming standard terms', () => {
    expect(modelDisplayPrice(entry(card), { mode: BillingTariffMode.AT_COST, markupBps: 0 }).input).toBe('250');
    expect(modelDisplayPrice(entry(card), { mode: BillingTariffMode.CUSTOM, markupBps: 1750 }).input).toBe('293.75');
    expect(modelDisplayPrice(entry(card), { mode: BillingTariffMode.FREE, markupBps: 0 }).output).toBe('0');
  });

  it('never rounds a positive small estimate to zero', () => {
    expect(modelDisplayPrice(entry({ ...card, input_price: 0.00000000001 }), standard).input).toBe('0.000001');
  });

  it.each([
    [null, 'missing'], [{ ...card, input_price: -1 }, 'invalid'],
    [{ ...card, basis: 'per token' }, 'non_token'], [{ ...card, unit: 'requests' }, 'non_token'],
    [{ ...card, currency: 'CNY' }, 'currency'], [{ ...card, pricing_mode: 'provider_resolved' }, 'dynamic'],
    [{ ...card, pricing_mode: 'subscription_included' }, 'dynamic'],
  ])('keeps unsupported card %j explicitly unavailable', (pricing, reason) => {
    expect(modelDisplayPrice(entry(pricing), standard)).toMatchObject({ status: 'unavailable', reason, input: null, output: null });
  });

  it('keeps missing sides unknown and carries explicit time bands, cache units and conditions', () => {
    const result = modelDisplayPrice(entry({ ...card, input_price: null, pricing_dimensions: [
      { label: 'Peak input', direction: 'input', usageUnit: 'tokens', unitPrice: 1,
        timeBand: 'peak', region: 'eu', contextMin: 128000, requiresProviderReceipt: true },
      { label: 'Off-peak cached input', direction: 'input', usageUnit: 'cached_tokens', unitPrice: 0.1,
        rateText: '0.100000000000000001', timeBand: 'offpeak' },
      { label: 'Request fee', direction: 'unit', usageUnit: 'requests', unitPrice: 3 },
    ] }), standard);
    expect(result.input).toBeNull();
    expect(result.dimensions).toMatchObject([
      { credits: '1300', time_band: 'peak', region: 'eu', context_min: 128000, requires_provider_receipt: true },
      { credits: '130.000001', time_band: 'offpeak', unit: 'cached_tokens' },
      { credits: null, unit: 'requests' },
    ]);
  });

  it('bounds batches and refuses browser-like extra fields', () => {
    const subject = { product: 'nessie', organisation_id: 'org', team_id: 'team', user_id: 'user' };
    expect(BillingModelPricesRequestSchema.safeParse({ ...subject, models: [] }).success).toBe(false);
    expect(BillingModelPricesRequestSchema.safeParse({ ...subject, models: Array(101).fill(entry(card)) }).success).toBe(false);
    expect(BillingModelPricesRequestSchema.safeParse({ ...subject, models: [entry(card)], markup: 0 }).success).toBe(false);
  });
});
