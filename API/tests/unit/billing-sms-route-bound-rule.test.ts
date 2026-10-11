import { describe, expect, it } from 'vitest';
import {
  SMS_ROUTE_BOUND_RULE, SMS_ROUTE_VALIDITY_MS, smsRouteRuleBounds, smsRouteRuleEvidence,
} from '../../src/services/billing-sms-route-bound-rule.js';

const account = `AC${'b'.repeat(32)}`;
const now = new Date('2026-10-11T12:00:00.000Z');

describe('the versioned route bound rule', () => {
  it('doubles the highest published carrier fee and the failed-message fee', () => {
    expect(smsRouteRuleBounds('outbound')).toEqual({ additional_per_segment: '0.01', additional_per_message: '0.002' });
    expect(smsRouteRuleBounds('inbound')).toEqual({ additional_per_segment: '0.007', additional_per_message: '0.002' });
    expect(SMS_ROUTE_BOUND_RULE).toMatchObject({ version: 'TWILIO_LONG_CODE_2X_V1', validityDays: 30, currency: 'USD' });
    expect(SMS_ROUTE_VALIDITY_MS).toBe(30 * 86_400_000);
  });
  it('assembles evidence naming the fetched price, page, retrieval time, rule version and every citation', () => {
    const text = smsRouteRuleEvidence({ accountSid: account, country: 'CZ', direction: 'inbound', price: {
      amount: '0.0075', currency: 'USD', country: 'CZ', observedAt: now,
      source: 'https://pricing.twilio.com/v1/Messaging/Countries/CZ' } });
    for (const part of ['TWILIO_LONG_CODE_2X_V1', 'current_price USD 0.0075', account, now.toISOString(),
      'https://www.twilio.com/en-us/sms/pricing/cz', 'https://pricing.twilio.com/v1/Messaging/Countries/CZ',
      SMS_ROUTE_BOUND_RULE.carrierFeeSource, SMS_ROUTE_BOUND_RULE.failedFeeSource, SMS_ROUTE_BOUND_RULE.segmentSource,
      'USD 0.007 = 2 x USD 0.0035', 'USD 0.002 = 2 x USD 0.001', '30 days']) expect(text).toContain(part);
  });
});
