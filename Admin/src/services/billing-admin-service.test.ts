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
});
