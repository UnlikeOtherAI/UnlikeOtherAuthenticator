import { describe, expect, it } from 'vitest';
import { assertBillingActionContext, mintBillingActionContext, freezeDisplayedBillingActions }
  from '../../src/services/billing-action-context.service.js';
import { readBillingModeProtocol } from '../../src/routes/billing/billing-mode-protocol.js';

const now = new Date('2026-11-07T17:00:00Z');
const binding = { account: { id: 'account_test', stripeAccountId: 'acct_main', livemode: false },
  revision: 1, appKeyId: 'nessie_key' };
const path = '/billing/v1/credits/top-up-checkout';
const body = { product: 'nessie', organisation_id: 'org', team_id: 'team', user_id: 'person', offer_id: 'offer' };

describe('displayed billing context', () => {
  it('accepts the original opaque context with a fresh actor and unchanged frozen action', () => {
    const token = mintBillingActionContext(binding, path, body, now);
    expect(token.length).toBeLessThanOrEqual(2048);
    expect(() => assertBillingActionContext(token, binding, path, body, new Date(now.getTime() + 1000)))
      .not.toThrow();
  });
  it.each([
    ['subject', { ...body, user_id: 'other' }, binding, path],
    ['offer', { ...body, offer_id: 'other' }, binding, path],
    ['product', { ...body, product: 'deepwater' }, binding, path],
    ['app', body, { ...binding, appKeyId: 'other_key' }, path],
    ['endpoint', body, binding, '/billing/v1/credits/auto-top-up/setup'],
  ])('refuses an original token rebound to another %s', (_kind, request, expectedBinding, endpoint) => {
    const token = mintBillingActionContext(binding, path, body, now);
    expect(() => assertBillingActionContext(token, expectedBinding, endpoint, request, now))
      .toThrow('BILLING_CONTEXT_INVALID');
  });
  it.each([
    ['revision', { ...binding, revision: 2 }],
    ['mode', { ...binding, account: { ...binding.account, livemode: true } }],
    ['account', { ...binding, account: { ...binding.account, stripeAccountId: 'acct_other' } }],
  ])('refuses a stale %s without minting or substituting a fresh context', (_kind, changed) => {
    const original = mintBillingActionContext(binding, path, body, now);
    expect(() => assertBillingActionContext(original, changed, path, body, now))
      .toThrow('BILLING_CONTEXT_STALE');
    expect(() => assertBillingActionContext(original, binding, path, body,
      new Date(now.getTime() + 10 * 60_000))).toThrow('BILLING_CONTEXT_STALE');
  });
  it('refuses missing, modified and oversized bindings', () => {
    expect(() => assertBillingActionContext(undefined, binding, path, body, now))
      .toThrow('BILLING_CONTEXT_REQUIRED');
    const token = mintBillingActionContext(binding, path, body, now);
    expect(() => assertBillingActionContext(token + 'x', binding, path, body, now))
      .toThrow('BILLING_CONTEXT_INVALID');
    expect(() => assertBillingActionContext('x'.repeat(2049), binding, path, body, now))
      .toThrow('BILLING_CONTEXT_INVALID');
  });
  it('permits truly unbound compatibility only for an untouched default-live team', () => {
    const live = { ...binding, revision: 0, account: { ...binding.account, livemode: true } };
    expect(() => assertBillingActionContext(undefined, live, path, body, now)).not.toThrow();
    expect(() => assertBillingActionContext(undefined, { ...live, revision: 2 }, path, body, now))
      .toThrow('BILLING_CONTEXT_REQUIRED');
  });
  it('freezes the displayed body without changing the source DTO or upgrading an unbound read', () => {
    const value = { capabilities: { can_top_up: true }, action: { enabled: true, disabled_reason: null,
      request: { method: 'POST', path, body } } };
    const bound = freezeDisplayedBillingActions(value, binding, true, 'Refresh billing', now);
    expect(bound.action.request.body).toHaveProperty('billing_context');
    expect(value.action.request.body).not.toHaveProperty('billing_context');
    const old = freezeDisplayedBillingActions(value, binding, false, 'Refresh billing', now);
    expect(old.action.enabled).toBe(false);
    expect(old.capabilities.can_top_up).toBe(false);
    expect(old.action.request.body).not.toHaveProperty('billing_context');
  });
  it('accepts only exact independent negotiation', () => {
    expect(readBillingModeProtocol({})).toBe(false);
    expect(readBillingModeProtocol({ 'x-uoa-billing-mode-protocol': '1.0.0' })).toBe(true);
    expect(() => readBillingModeProtocol({ 'x-uoa-billing-mode-protocol': ['1.0.0', '1.0.0'] }))
      .toThrow('BILLING_CONTEXT_INVALID');
  });
  it('pins captured subscription/customer identity without changing the public action body',()=>{
    const portal='/billing/v1/stripe/portal-session',epoch='2026-11-08T00:00:00.000Z';
    const original={...binding,scopeEpoch:epoch,objectBinding:'captured-subscription/customer'};
    const token=mintBillingActionContext(original,portal,body,now);
    expect(()=>assertBillingActionContext(token,original,portal,body,now)).not.toThrow();
    expect(()=>assertBillingActionContext(token,{...original,objectBinding:'replacement-subscription/customer'},portal,body,now))
      .toThrow('BILLING_CONTEXT_STALE');
    expect(()=>assertBillingActionContext(mintBillingActionContext({...binding,scopeEpoch:epoch},portal,body,now),original,portal,body,now))
      .toThrow('BILLING_CONTEXT_STALE');
    expect(()=>assertBillingActionContext(undefined,original,portal,body,now)).toThrow('BILLING_CONTEXT_REQUIRED');
    const input={actions:[{request:{method:'POST',path:portal,body}},{request:{method:'POST',path,body}}]};
    const frozen=freezeDisplayedBillingActions(input,original,true,'Refresh',now);
    expect(()=>assertBillingActionContext((frozen.actions[0]!.request.body as typeof body&{billing_context:string}).billing_context,
      original,portal,body,now)).not.toThrow();
    expect(()=>assertBillingActionContext((frozen.actions[1]!.request.body as typeof body&{billing_context:string}).billing_context,
      {...binding,scopeEpoch:epoch},path,body,now)).not.toThrow();
    expect(input.actions[0]!.request.body).not.toHaveProperty('billing_context');
  });
});
