import { expect, it } from 'vitest';
import { BillingAppKeyFormSchema } from './billing';
import { SmsRouteImportSchema, SmsRoutePolicySchema } from './billing-sms-policies';
it('makes SMS runtime reachable without customer return origins and rejects redirect authority', () => {
  const input = { purpose: 'sms_runtime', name: 'Nessie runtime', actorIssuer: 'https://api.nessie.works',
    actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
    actorPublicJwkJson: '{}', checkoutReturnOrigins: '', expiresAt: '' };
  expect(BillingAppKeyFormSchema.parse(input).purpose).toBe('sms_runtime');
  expect(BillingAppKeyFormSchema.safeParse({ ...input, checkoutReturnOrigins: 'https://nessie.works' }).success).toBe(false);
});
it('requires both documentary bounds, exact account/country and precise decimal without zero defaults', () => {
  const input = { account_sid: `AC${'a'.repeat(32)}`, country: 'GB', currency: 'USD', direction: 'outbound',
    additional_per_segment: '0.000000000000000001', additional_per_message: '0.001',
    source: 'https://provider.example/terms', evidence: 'Documented complete fees for the exact route.', expires_at: '2026-11-01T00:00:00Z' };
  expect(SmsRouteImportSchema.parse(input).additional_per_segment).toBe(input.additional_per_segment);
  for (const change of [{ additional_per_segment: '' }, { additional_per_message: undefined }, { currency: 'GBP' },
    { account_sid: '*' }, { evidence: '' }, { additional_per_segment: '0.0000000000000000001' }]) {
    expect(SmsRouteImportSchema.safeParse({ ...input, ...change }).success).toBe(false);
  }
});
it('reads renewal-job acceptances, which carry no UOA subject, beside operator ones', () => {
  const route = { id: 'route-2', account_sid: `AC${'a'.repeat(32)}`, country: 'GB', direction: 'outbound', currency: 'USD',
    additional_per_segment: '0.01', additional_per_message: '0.002', source: 'https://www.twilio.com/en-us/sms/pricing/gb',
    evidence_digest: 'a'.repeat(64), expires_at: '2026-11-10T00:00:00.000Z', accepted_by: 'renewal_job',
    accepted_by_user_id: null, accepted_at: '2026-11-03T00:00:00.000Z', acceptance_reason: 'Automatic renewal',
    provider_price: '0.055', renewal_of_id: 'route-1' };
  expect(SmsRoutePolicySchema.parse(route).accepted_by_user_id).toBeNull();
  expect(SmsRoutePolicySchema.safeParse({ ...route, accepted_by: 'someone' }).success).toBe(false);
});
