import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { billingCheckoutSessionRequestJsonSchema, billingPortalSessionRequestJsonSchema,
  billingCreditsTopUpActionJsonSchema, BILLING_MODE_PROTOCOL_HEADER,
  BILLING_MODE_PROTOCOL_VERSION } from '../src/index.js';

describe('opaque displayed billing context', () => {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const subject = { product: 'nessie', organisation_id: 'org', team_id: 'team', user_id: 'person' };
  it('publishes independent negotiation without widening an action body', () => {
    expect(BILLING_MODE_PROTOCOL_HEADER).toBe('x-uoa-billing-mode-protocol');
    expect(BILLING_MODE_PROTOCOL_VERSION).toBe('1.0.0');
    const valid = ajv.compile(billingCreditsTopUpActionJsonSchema);
    const action = { id: 'top_up', kind: 'hosted_redirect', label: 'Add credits',
      description: 'Add credits', enabled: true, disabled_reason: null,
      request: { method: 'POST', path: '/billing/v1/credits/top-up-checkout',
        body: { ...subject, offer_id: 'offer', billing_context: 'opaque-original-display-binding' } } };
    expect(valid(action)).toBe(true);
    expect(valid({ ...action, request: { ...action.request,
      body: { ...action.request.body, stripe_account: 'acct_browser_selected' } } })).toBe(false);
    expect(valid({ ...action, request: { ...action.request,
      body: { ...action.request.body, billing_context: 'x'.repeat(2049) } } })).toBe(false);
  });
  it('accepts the optional binding and preserves legacy Checkout and Portal schemas', () => {
    const checkout = ajv.compile(billingCheckoutSessionRequestJsonSchema);
    const portal = ajv.compile(billingPortalSessionRequestJsonSchema);
    const body = { ...subject, success_url: 'https://app.example/ok', cancel_url: 'https://app.example/back' };
    expect(checkout(body)).toBe(true);
    expect(checkout({ ...body, billing_context: 'opaque' })).toBe(true);
    expect(portal({ ...subject, return_url: 'https://app.example/billing', billing_context: 'opaque' })).toBe(true);
  });
});
