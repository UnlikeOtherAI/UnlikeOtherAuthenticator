import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredSmsProvider } from '../src/services/billing-sms-runtime.service.js';

const configuration = vi.hoisted(() => ({
  BILLING_SMS_ENABLED: true,
  BILLING_SMS_TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  BILLING_SMS_TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
  BILLING_SMS_TWILIO_API_KEY_SECRET: 'synthetic-us1',
}));
vi.mock('../src/config/env.js', () => ({ getEnv: () => configuration }));
afterEach(() => { vi.unstubAllEnvs(); configuration.BILLING_SMS_ENABLED = true; });

describe('SMS regional runtime configuration', () => {
  it('preserves the disabled runtime gate even with complete regional configuration', () => {
    configuration.BILLING_SMS_ENABLED = false;
    vi.stubEnv('BILLING_SMS_TWILIO_REGION', 'ie1');
    vi.stubEnv('BILLING_SMS_TWILIO_IE1_API_KEY_SID', `SK${'3'.repeat(32)}`);
    vi.stubEnv('BILLING_SMS_TWILIO_IE1_API_KEY_SECRET', 'synthetic-ie1');
    expect(configuredSmsProvider).toThrow('BILLING_SMS_DISABLED');
  });
  it('keeps the existing US1 deployment default', () => {
    vi.stubEnv('BILLING_SMS_TWILIO_REGION', undefined);
    expect(configuredSmsProvider().configuration.region).toBe('us1');
  });
  it('refuses an unknown or empty region instead of silently using US1', () => {
    for (const region of ['au1', '', 'IE1']) {
      vi.stubEnv('BILLING_SMS_TWILIO_REGION', region);
      expect(configuredSmsProvider).toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
    }
  });
  it('requires the independent IE1 credential pair and wires it into the provider', () => {
    vi.stubEnv('BILLING_SMS_TWILIO_REGION', 'ie1');
    vi.stubEnv('BILLING_SMS_TWILIO_IE1_API_KEY_SID', undefined);
    vi.stubEnv('BILLING_SMS_TWILIO_IE1_API_KEY_SECRET', undefined);
    expect(configuredSmsProvider).toThrow('BILLING_SMS_PROVIDER_EVIDENCE_UNAVAILABLE');
    vi.stubEnv('BILLING_SMS_TWILIO_IE1_API_KEY_SID', `SK${'3'.repeat(32)}`);
    vi.stubEnv('BILLING_SMS_TWILIO_IE1_API_KEY_SECRET', 'synthetic-ie1');
    expect(configuredSmsProvider().configuration).toMatchObject({ region: 'ie1',
      apiKeySid: configuration.BILLING_SMS_TWILIO_API_KEY_SID,
      ie1ApiKeySid: `SK${'3'.repeat(32)}`, ie1ApiKeySecret: 'synthetic-ie1' });
  });
});
