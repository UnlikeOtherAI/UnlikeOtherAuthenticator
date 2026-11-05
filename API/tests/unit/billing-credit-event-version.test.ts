import { describe, expect, it } from 'vitest';
import { assertStripeEventApiVersion } from '../../src/services/billing-stripe-webhook-event.service.js';

const data = { object: { object: 'payment_intent', status: 'succeeded', metadata: { uoa_credit_top_up_checkout_id: 'purchase',
  uoa_service_id: 'service', uoa_app_key_id: 'key', uoa_credit_account_id: 'wallet' } } };
const event = { type: 'payment_intent.succeeded', api_version: '2025-12-15.clover', data };
describe('credit payment snapshot versions', () => {
  it('recognises the captured Clover credit payment event', () => {
    expect(() => assertStripeEventApiVersion(event as never)).not.toThrow();
  });
  it.each([{ type: 'invoice.paid' }, { api_version: 'unknown' }, { data: { object: { ...data.object, metadata: {} } } },
    { data: { object: { ...data.object, status: 'processing' } } }])('refuses unsupported snapshots %#', patch => {
    expect(() => assertStripeEventApiVersion({ ...event, ...patch } as never)).toThrow('STRIPE_WEBHOOK_API_VERSION_UNSUPPORTED');
  });
});
