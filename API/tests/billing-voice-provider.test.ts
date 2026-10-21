import { describe, expect, it, vi } from 'vitest';
import { BillingVoiceProvider } from '../src/services/billing-voice-provider.service.js';
import { configuredVoicePolicy, voicePolicySchema } from '../src/services/billing-voice-policy.service.js';
const accountSid = `AC${'a'.repeat(32)}`;
const config = { accountSid, apiKeySid: `SK${'b'.repeat(32)}`, apiKeySecret: 'synthetic-only' };
const route = { accountSid, from: '+420777000001', to: '+420777000002', direction: 'outbound' as const };
function provider(body: unknown) {
  return new BillingVoiceProvider(config, async () => new Response(JSON.stringify(body), { status: 200 }));
}
describe('Voice provider evidence', () => {
  it('uses the conservative maximum exact-number origin rate and refuses missing currency evidence', async () => {
    const body = { number: route.to, price_unit: 'USD', outbound_call_prices: [{ current_price: '0.01' }, { current_price: '0.13' }] };
    expect((await provider(body).price(route)).amount).toBe('0.13');
    await expect(provider({ ...body, price_unit: 'EUR' }).price(route)).rejects.toThrow();
    await expect(provider({ ...body, outbound_call_prices: [{ current_price: null }] }).price(route)).rejects.toThrow();
    await expect(provider({ ...body, number: route.from }).price(route)).rejects.toThrow();
  });
  it('validates the exact voice-capable owned number', async () => {
    const sid = `PN${'c'.repeat(32)}`;
    await expect(provider({ sid, account_sid: accountSid, phone_number: route.from,
      capabilities: { voice: false, sms: true } }).ownedNumber(accountSid, sid, route.from)).rejects.toThrow();
  });
  it('retains missing receipt price and refuses wrong destination/direction/positive charge', async () => {
    const sid = `CA${'d'.repeat(32)}`;
    const body = { sid, account_sid: accountSid, from: route.from, to: route.to, direction: 'outbound-api',
      status: 'completed', price: null, price_unit: 'USD', duration: '60', parent_call_sid: null, start_time: null };
    expect(await provider(body).receipt(route, sid)).toMatchObject({ terminal: true, amount: null, seconds: 60 });
    expect((await provider({ ...body, price: '-0.013' }).receipt(route, sid)).amount).toBe('0.013');
    await expect(provider({ ...body, price: '0.013' }).receipt(route, sid)).rejects.toThrow();
    await expect(provider({ ...body, to: route.from }).receipt(route, sid)).rejects.toThrow();
    await expect(provider({ ...body, direction: 'inbound' }).receipt(route, sid)).rejects.toThrow();
  });
  it('keeps admission disabled without operator-owned pricing and cutoff evidence', () => {
    vi.stubEnv('BILLING_VOICE_ENABLED', 'true'); vi.stubEnv('BILLING_VOICE_POLICY_JSON', '{}');
    expect(() => configuredVoicePolicy()).toThrow('BILLING_VOICE_EVIDENCE_UNAVAILABLE');
    vi.unstubAllEnvs();
  });
});


describe('Voice activation policy', () => {
  const policy = { version: 'fixture', accountSid, region: 'us1', expiresAt: '2099-01-01T00:00:00.000Z',
    markupBps: 2700, billingIncrementSeconds: 60, minimumBilledSeconds: 60, maxDurationSeconds: 600,
    pricingEvidenceDigest: 'a'.repeat(64), cutoffEvidenceDigest: 'b'.repeat(64),
    featureProfile: 'connectivity_only', ancillaryCharges: 'none' };
  it.each([
    { billingIncrementSeconds: 1 }, { minimumBilledSeconds: 0 },
    { featureProfile: 'media_streams' }, { ancillaryCharges: 'included' },
    { streamPricePerMinute: '0.0044' },
  ])('refuses unsupported billing or feature configuration %j', change => {
    expect(voicePolicySchema.safeParse({ ...policy, ...change }).success).toBe(false);
  });
  it('requires explicit enablement and unexpired evidence even with complete policy', () => {
    try {
      vi.stubEnv('BILLING_VOICE_POLICY_JSON', JSON.stringify(policy));
      vi.stubEnv('BILLING_VOICE_ENABLED', 'false');
      expect(() => configuredVoicePolicy()).toThrow('BILLING_VOICE_EVIDENCE_UNAVAILABLE');
      vi.stubEnv('BILLING_VOICE_ENABLED', 'true');
      vi.stubEnv('BILLING_VOICE_POLICY_JSON', JSON.stringify({ ...policy, expiresAt: '2000-01-01T00:00:00.000Z' }));
      expect(() => configuredVoicePolicy()).toThrow('BILLING_VOICE_EVIDENCE_UNAVAILABLE');
    } finally { vi.unstubAllEnvs(); }
  });
});
