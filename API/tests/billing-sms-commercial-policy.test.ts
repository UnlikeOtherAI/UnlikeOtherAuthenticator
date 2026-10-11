import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readSmsCommercialPolicy } from '../src/services/billing-sms-commercial-policy.service.js';

describe('private SMS deployment policy', () => {
  beforeEach(() => vi.stubEnv('UOA_SMS_PRICING_MODE', 'legacy'));
  afterEach(() => vi.unstubAllEnvs());
  it('refuses missing policy instead of supplying commercial defaults', () => {
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', undefined);
    vi.stubEnv('UOA_SMS_MONTHLY_FEE_EUR', undefined);
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', undefined);
    expect(readSmsCommercialPolicy).toThrow('BILLING_SMS_COMMERCIAL_POLICY_REQUIRED');
  });
  it('validates independent synthetic terms without returning them to customer DTOs', () => {
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-policy');
    vi.stubEnv('UOA_SMS_MONTHLY_FEE_EUR', '7.25');
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '2700');
    expect(readSmsCommercialPolicy()).toEqual({ version: 'synthetic-policy', monthlyFeeEur: '7.25', monthlyMarkupBps: 0, messageMarkupBps: 2700 });
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '-1');
    expect(readSmsCommercialPolicy).toThrow();
  });
  it('applies one explicit provider markup to rental and usage without a fixed increment', () => {
    vi.stubEnv('UOA_SMS_PRICING_MODE', 'provider_markup');
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-uniform');
    vi.stubEnv('UOA_SMS_PROVIDER_MARKUP_BPS', '1500');
    vi.stubEnv('UOA_SMS_MONTHLY_FEE_EUR', '99');
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '8000');
    expect(readSmsCommercialPolicy()).toEqual({ version: 'synthetic-uniform', monthlyFeeEur: '0',
      monthlyMarkupBps: 1500, messageMarkupBps: 1500 });
    vi.stubEnv('UOA_SMS_PROVIDER_MARKUP_BPS', undefined);
    expect(readSmsCommercialPolicy).toThrow('BILLING_SMS_COMMERCIAL_POLICY_REQUIRED');
  });
  it('refuses invalid policy modes and malformed uniform markups', () => {
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-uniform');
    vi.stubEnv('UOA_SMS_PRICING_MODE', 'provider_markup');
    for (const value of ['', '-1', '1.5', '1000000', 'NaN']) {
      vi.stubEnv('UOA_SMS_PROVIDER_MARKUP_BPS', value);
      expect(readSmsCommercialPolicy).toThrow('BILLING_SMS_COMMERCIAL_POLICY_REQUIRED');
    }
    vi.stubEnv('UOA_SMS_PRICING_MODE', 'unknown');
    expect(readSmsCommercialPolicy).toThrow('BILLING_SMS_COMMERCIAL_POLICY_REQUIRED');
  });

});
