import { beforeEach, describe, expect, it, vi } from 'vitest';

import { billingAdminService } from './billing-admin-service';

const api = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock('./api-client', () => ({
  createApiClient: () => api,
}));

const tariff = {
  id: 'tariff-1',
  service_id: 'service-1',
  key: 'standard',
  version: 1,
  name: 'Standard',
  mode: 'standard',
  collection_mode: 'stripe',
  markup_bps: 2000,
  monthly_subscription: { amount_minor: '2000', currency: 'GBP' },
  is_default: true,
  created_by_email: 'operator@example.com',
  created_at: '2026-07-20T00:00:00.000Z',
};

const creditAccount = {
  id: 'credit-account-1',
  organisation: { id: 'org-1', name: 'Example Org' },
  team: { id: 'team-1', name: 'Research' },
  mode: 'live',
  remaining_credits: {
    credits: '50000',
    display: '50,000 credits',
    usd_equivalent: { amount: '50', currency: 'USD', display: 'US$50.00' },
  },
  updated_at: '2026-07-21T10:00:00.000Z',
  recent_adjustments: [
    {
      id: 'credit-adjustment-1',
      signed_credits: {
        credits: '50000',
        display: '+50,000 credits',
        usd_equivalent: { amount: '50', currency: 'USD', display: '+US$50.00' },
      },
      reason: 'Restore the verified pre-test balance',
      idempotency_key: 'restore:team-1:2026-07-21',
      created_by: {
        user_id: 'user-1',
        email: 'operator@example.com',
        admin_domain: 'admin.example.com',
      },
      created_at: '2026-07-21T10:00:00.000Z',
    },
  ],
};

describe('billingAdminService', () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
  });

  it('maps operator tariff terms without converting integer money to floating point', async () => {
    api.post.mockResolvedValue(tariff);

    await billingAdminService.createTariff('service-1', {
      key: 'standard',
      name: 'Standard',
      mode: 'standard',
      collectionMode: 'stripe',
      markupBps: 2000,
      monthlyAmountMinor: '2000',
      currency: 'GBP',
      setAsDefault: true,
    });

    expect(api.post).toHaveBeenCalledWith('/internal/admin/billing/services/service-1/tariffs', {
      key: 'standard',
      name: 'Standard',
      mode: 'standard',
      collection_mode: 'stripe',
      markup_bps: 2000,
      monthly_subscription: { amount_minor: '2000', currency: 'GBP' },
      set_as_default: true,
    });
  });

  it('parses a public actor JWK and returns the product key only from creation', async () => {
    api.post.mockResolvedValue({
      id: 'app-key-1',
      service_id: 'service-1',
      purpose: 'customer_lifecycle',
      name: 'DeepWater production',
      key_prefix: 'uoa_app_abcd…',
      actor_issuer: 'https://api.deepwater.example',
      actor_audience: 'https://authentication.example/billing/v1/effective-tariff',
      actor_key_id: 'actor-2026',
      checkout_return_origins: ['https://app.nessie.works'],
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      created_by_email: 'operator@example.com',
      created_at: '2026-07-20T00:00:00.000Z',
      key: 'uoa_app_plaintext_once',
    });

    const created = await billingAdminService.createAppKey('service-1', {
      purpose: 'customer_lifecycle',
      name: 'DeepWater production',
      actorIssuer: 'https://api.deepwater.example',
      actorAudience: 'https://authentication.example/billing/v1/effective-tariff',
      actorPublicJwkJson:
        '{"kty":"RSA","kid":"actor-2026","alg":"RS256","use":"sig","n":"modulus","e":"AQAB"}',
      checkoutReturnOrigins: 'https://app.nessie.works\nhttps://app.nessie.works/',
      expiresAt: '',
    });

    expect(created.key).toBe('uoa_app_plaintext_once');
    expect(api.post).toHaveBeenCalledWith(
      '/internal/admin/billing/services/service-1/app-keys',
      expect.objectContaining({
        purpose: 'customer_lifecycle',
        actor_public_jwk: expect.objectContaining({
          kty: 'RSA',
          kid: 'actor-2026',
        }),
        checkout_return_origins: ['https://app.nessie.works'],
        expires_at: null,
      }),
    );
  });

  it('rejects malformed API data instead of rendering an invented control-plane state', async () => {
    api.get.mockResolvedValue([{ id: 'service-1', identifier: 'deepwater' }]);
    await expect(billingAdminService.listServices()).rejects.toThrow();
  });

  it('sends exact minor-unit add-ons to the UOA control plane', async () => {
    api.post.mockResolvedValue({
      id: 'adjustment-1',
      service_id: 'service-1',
      key: 'priority-support',
      name: 'Priority support',
      kind: 'add_on',
      cadence: 'monthly',
      amount_minor: '1000',
      currency: 'GBP',
      scope: 'team',
      scope_key: 'org-1:team-1',
      organisation_id: 'org-1',
      team_id: 'team-1',
      starts_at: '2026-07-01T00:00:00.000Z',
      ends_at: null,
      active: true,
      created_at: '2026-07-20T00:00:00.000Z',
      updated_at: '2026-07-20T00:00:00.000Z',
    });

    await billingAdminService.createAdjustment('service-1', {
      organisationId: 'org-1',
      teamId: 'team-1',
      key: 'priority-support',
      name: 'Priority support',
      kind: 'add_on',
      cadence: 'monthly',
      amountMinor: '1000',
      currency: 'GBP',
      startsAt: '2026-07-01',
      endsAt: '',
    });

    expect(api.post).toHaveBeenCalledWith(
      '/internal/admin/billing/services/service-1/adjustments',
      {
        organisation_id: 'org-1',
        team_id: 'team-1',
        key: 'priority-support',
        name: 'Priority support',
        kind: 'add_on',
        cadence: 'monthly',
        amount_minor: '1000',
        currency: 'GBP',
        starts_at: '2026-07-01T00:00:00.000Z',
        ends_at: null,
      },
    );
  });

  it('loads display-ready shared team credit accounts without local conversion', async () => {
    api.get.mockResolvedValue({ accounts: [creditAccount] });

    const accounts = await billingAdminService.listCreditAccounts();

    expect(api.get).toHaveBeenCalledWith('/internal/admin/billing/credit-accounts');
    expect(accounts[0]?.remaining_credits.display).toBe('50,000 credits');
    expect(accounts[0]?.remaining_credits.usd_equivalent.display).toBe('US$50.00');
    expect(accounts[0]?.recent_adjustments[0]?.signed_credits.display).toBe('+50,000 credits');
  });

  it('posts a signed team credit delta with exact scope and stable request reference', async () => {
    api.post.mockResolvedValue({
      account: creditAccount,
      adjustment: creditAccount.recent_adjustments[0],
      replayed: false,
    });

    const result = await billingAdminService.createCreditAdjustment(creditAccount, {
      signedCredits: '-2500',
      reason: 'Reverse a duplicate support grant',
      idempotencyKey: 'support-reversal:team-1:2026-07-21',
    });

    expect(api.post).toHaveBeenCalledWith(
      '/internal/admin/billing/credit-accounts/credit-account-1/adjustments',
      {
        organisation_id: 'org-1',
        team_id: 'team-1',
        signed_credits: '-2500',
        reason: 'Reverse a duplicate support grant',
        idempotency_key: 'support-reversal:team-1:2026-07-21',
      },
    );
    expect(result.replayed).toBe(false);
  });
});
