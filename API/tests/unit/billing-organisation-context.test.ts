import { describe, expect, it } from 'vitest';
import { assertBillingActionContext, freezeDisplayedBillingActions, mintBillingActionContext }
  from '../../src/services/billing-action-context.service.js';

const base = { account: { id: 'local-live', stripeAccountId: 'acct_main', livemode: true },
  appKeyId: 'app', revision: 0 };
const binding = { ...base, scopeEpoch: '2026-11-07T22:00:00.000Z' };
const body = { product: 'nessie', organisation_id: 'org', team_id: 'actor-team', user_id: 'manager' };
const endpoint = '/billing/v1/stripe/checkout-session';

describe('organisation financial context', () => {
  it('refuses an unbound old click even at LIVE revision zero', () => {
    expect(() => assertBillingActionContext(undefined, binding, endpoint, body)).toThrow('BILLING_CONTEXT_REQUIRED');
  });
  it('invalidates a formerly valid team token without upgrading or reminting it', () => {
    const legacy = mintBillingActionContext(base, endpoint, body);
    expect(() => assertBillingActionContext(legacy, binding, endpoint, body)).toThrow('BILLING_CONTEXT_STALE');
  });
  it('captures epoch, exact account/mode, revision, actor context and endpoint', () => {
    const token = mintBillingActionContext(binding, endpoint, body);
    expect(() => assertBillingActionContext(token, binding, endpoint, body)).not.toThrow();
    expect(() => assertBillingActionContext(token, { ...binding, scopeEpoch: '2026-11-08T00:00:00.000Z' }, endpoint, body))
      .toThrow('BILLING_CONTEXT_STALE');
    expect(() => assertBillingActionContext(token, { ...binding, revision: 1 }, endpoint, body)).toThrow('BILLING_CONTEXT_STALE');
    expect(() => assertBillingActionContext(token, { ...binding, account: { ...binding.account, livemode: false } }, endpoint, body))
      .toThrow('BILLING_CONTEXT_STALE');
    expect(() => assertBillingActionContext(token, binding, endpoint, { ...body, team_id: 'different-team' }))
      .toThrow('BILLING_CONTEXT_INVALID');
  });
  it('disables old-client new-work actions and preserves the untouched input', () => {
    const input = { capabilities: { can_upgrade: true }, actions: [{ enabled: true, disabled_reason: null,
      request: { method: 'POST', path: endpoint, body } }] };
    const frozen = freezeDisplayedBillingActions(input, binding, false, 'Refresh billing.');
    expect(frozen.capabilities.can_upgrade).toBe(false);
    expect(frozen.actions[0]?.enabled).toBe(false);
    expect(input.actions[0]?.enabled).toBe(true);
  });
});
