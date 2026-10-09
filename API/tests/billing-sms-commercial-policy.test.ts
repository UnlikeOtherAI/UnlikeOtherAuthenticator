import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSmsCommercialPolicy } from '../src/services/billing-sms-commercial-policy.service.js';

describe('private SMS deployment policy', () => {
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
    expect(readSmsCommercialPolicy()).toEqual({ version: 'synthetic-policy', monthlyFeeEur: '7.25', messageMarkupBps: 2700 });
    vi.stubEnv('UOA_SMS_MESSAGE_MARKUP_BPS', '-1');
    expect(readSmsCommercialPolicy).toThrow();
  });
});
