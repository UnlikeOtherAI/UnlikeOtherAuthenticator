import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { billingSmsFinalQuoteV1JsonSchema, billingSmsReserveRequestV1JsonSchema,
  billingSmsNumberV1JsonSchema, billingSmsStandingRetireResultV1JsonSchema,
  billingSmsGrantRevokeResultV1JsonSchema, billingSmsReleaseResultV1JsonSchema,
  billingSmsInboundReceiptRequestV1JsonSchema } from '../src/sms-schema.js';
import { billingSmsV1OpenApiDocument } from '../src/sms-openapi.js';
import { BILLING_SMS_PATHS } from '../src/sms-types.js';

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const quote = {
  id: 'quote-synthetic', amount: '0.00000000000127', currency: 'USD',
  expires_at: '2026-10-08T12:05:00.000Z',
  rate_basis: 'maximum_mobile_carrier',
  scope: { organisation_id: 'org-synthetic', country: 'CZ', number_type: 'mobile',
    direction: 'outbound', destination: '+420777000000', carrier: null, mcc: null, mnc: null },
};

describe('SMS commercial protocol', () => {
  it('publishes every registered path and accepts only exact fenced recovery proofs', () => {
    expect(Object.keys(billingSmsV1OpenApiDocument.paths).sort()).toEqual(Object.values(BILLING_SMS_PATHS).sort());
    const retire = ajv.compile(billingSmsStandingRetireResultV1JsonSchema);
    expect(retire({ number_id: 'number', allocation_id: 'allocation', state: 'retired', can_fund: false })).toBe(true);
    expect(retire({ number_id: 'number', allocation_id: 'allocation', state: 'retired', can_fund: true })).toBe(false);
    expect(ajv.compile(billingSmsGrantRevokeResultV1JsonSchema)({ grant_id: 'grant', state: 'revoked' })).toBe(true);
    const release = ajv.compile(billingSmsReleaseResultV1JsonSchema);
    expect(release({ dispatch_id: 'dispatch', state: 'released', can_dispatch: false })).toBe(true);
    expect(release({ dispatch_id: 'dispatch', state: 'released' })).toBe(false);
  });

  it('requires frozen canonical hierarchy for machine inbound evidence', () => {
    const validate = ajv.compile(billingSmsInboundReceiptRequestV1JsonSchema);
    const input = { product: 'nessie', number_id: 'number', allocation_id: 'allocation',
      organisation_id: 'org', team_id: 'team', message_sid: `SM${'a'.repeat(32)}` };
    expect(validate(input)).toBe(true);
    const { team_id: _team, ...missing } = input;
    expect(validate(missing)).toBe(false);
    expect(validate({ ...input, provider_price: '0.01' })).toBe(false);
  });
  it('preserves tiny exact final customer prices and rejects private pricing fields', () => {
    const validate = ajv.compile(billingSmsFinalQuoteV1JsonSchema);
    expect(validate(quote)).toBe(true);
    expect(validate({ ...quote, provider_cost: '0.1' })).toBe(false);
    expect(validate({ ...quote, amount: 0.01 })).toBe(false);
    expect(validate({ ...quote, scope: { ...quote.scope, markup_bps: 2700 } })).toBe(false);
  });

  it('requires exact physical dispatch and allocation identity before reserving', () => {
    const validate = ajv.compile(billingSmsReserveRequestV1JsonSchema);
    const request = { product: 'nessie', organisation_id: 'org-synthetic', team_id: 'team-synthetic',
      user_id: 'user-synthetic', dispatch_id: 'dispatch-synthetic', request_fingerprint: 'a'.repeat(64),
      number_id: 'number-synthetic', allocation_id: 'allocation-synthetic',
      account_sid: `AC${'a'.repeat(32)}`, from: '+420777000001', to: '+420777000000',
      quote_id: quote.id, max_segments: 2, grant_id: null, delegate_id: null };
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, max_segments: 0 })).toBe(false);
    expect(validate({ ...request, allocation_id: '' })).toBe(false);
    expect(validate({ ...request, raw_cost_bound: '1' })).toBe(false);
  });

  it('keeps monthly payment and provider acquisition as separate proven states', () => {
    const validate = ajv.compile(billingSmsNumberV1JsonSchema);
    expect(validate({ resource_id: 'resource-synthetic', organisation_id: 'org-synthetic',
      phone_number: '+420777000001', state: 'payment_pending', quote,
      acquisition_authorized: false, checkout_url: null, disabled_reason: null })).toBe(true);
    expect(validate({ resource_id: 'resource-synthetic', organisation_id: 'org-synthetic',
      phone_number: '+420777000001', state: 'paid', quote,
      acquisition_authorized: true, checkout_url: null, disabled_reason: null,
      stripe_subscription_id: 'sub_private' })).toBe(false);
  });
});
