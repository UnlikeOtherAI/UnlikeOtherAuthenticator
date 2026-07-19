import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { resetBillingAssertionKeyCache } from '../../src/services/billing-ledger-collector.service.js';
import { resetTariffSnapshotKeyCache } from '../../src/services/billing-snapshot.service.js';

const appKeyService = vi.hoisted(() => ({
  verifyBillingAppKey: vi.fn(),
}));
const entitlementService = vi.hoisted(() => ({
  getEffectiveTariffSnapshot: vi.fn(),
}));

vi.mock('../../src/services/billing-app-key.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-app-key.service.js')
  >('../../src/services/billing-app-key.service.js');
  return { ...actual, ...appKeyService };
});

vi.mock('../../src/services/billing-entitlement.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-entitlement.service.js')
  >('../../src/services/billing-entitlement.service.js');
  return { ...actual, ...entitlementService };
});

const envNames = [
  'SHARED_SECRET',
  'DATABASE_URL',
  'PUBLIC_BASE_URL',
  'TARIFF_SNAPSHOT_PRIVATE_JWK',
  'TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON',
  'UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK',
  'UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON',
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]])) as Record<
  (typeof envNames)[number],
  string | undefined
>;

function restoreEnv(): void {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

const credential = {
  id: 'app-key-1',
  actorIssuer: 'https://ledger.example.com',
  actorAudience: 'https://auth.example.com/billing/v1/effective-tariff',
  actorKeyId: 'ledger-actor-1',
  actorPublicJwk: {
    kty: 'RSA',
    kid: 'ledger-actor-1',
    n: 'modulus',
    e: 'AQAB',
  },
  service: {
    id: 'service-1',
    identifier: 'deepwater',
    name: 'DeepWater',
  },
};

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const billingAssertionKeyPair = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const billingAssertionPrivateJwk = await exportJWK(
    billingAssertionKeyPair.privateKey,
  );
  const billingAssertionPublicJwk = await exportJWK(
    billingAssertionKeyPair.publicKey,
  );
  Object.assign(privateJwk, {
    kid: 'tariff-snapshot-test',
    alg: 'RS256',
    use: 'sig',
  });
  Object.assign(publicJwk, {
    kid: 'tariff-snapshot-test',
    alg: 'RS256',
    use: 'sig',
  });
  Object.assign(billingAssertionPrivateJwk, {
    kid: 'billing-assertion-test',
    alg: 'RS256',
    use: 'sig',
  });
  Object.assign(billingAssertionPublicJwk, {
    kid: 'billing-assertion-test',
    alg: 'RS256',
    use: 'sig',
  });

  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  process.env.PUBLIC_BASE_URL = 'https://auth.example.com';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
  process.env.TARIFF_SNAPSHOT_PRIVATE_JWK = JSON.stringify(privateJwk);
  process.env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON = JSON.stringify({ keys: [publicJwk] });
  process.env.UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK = JSON.stringify(
    billingAssertionPrivateJwk,
  );
  process.env.UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON = JSON.stringify({
    keys: [billingAssertionPublicJwk],
  });
  resetTariffSnapshotKeyCache();
  resetBillingAssertionKeyCache();
});

afterAll(() => {
  restoreEnv();
  resetTariffSnapshotKeyCache();
  resetBillingAssertionKeyCache();
});

beforeEach(() => {
  vi.clearAllMocks();
  appKeyService.verifyBillingAppKey.mockResolvedValue(credential);
  entitlementService.getEffectiveTariffSnapshot.mockResolvedValue({
    snapshot: 'signed-snapshot',
    payload: {
      schema_version: 1,
      product: { identifier: 'deepwater' },
    },
  });
});

async function withApp(
  callback: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>,
): Promise<void> {
  const app = await createApp();
  await app.ready();
  try {
    await callback(app);
  } finally {
    await app.close();
  }
}

describe('billing app API routes', () => {
  it('requires an individual app key before resolving a tariff', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/effective-tariff',
        headers: { 'x-uoa-actor': 'signed-actor' },
        payload: {
          product: 'deepwater',
          organisation_id: 'org-1',
          team_id: 'team-1',
          user_id: 'user-1',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(appKeyService.verifyBillingAppKey).not.toHaveBeenCalled();
      expect(entitlementService.getEffectiveTariffSnapshot).not.toHaveBeenCalled();
    });
  });

  it('binds the authenticated app key and signed actor to the request', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/effective-tariff',
        headers: {
          'x-uoa-app-key': 'uoa_app_individual-product-key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: {
          product: 'deepwater',
          organisation_id: 'org-1',
          team_id: 'team-1',
          user_id: 'user-1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(appKeyService.verifyBillingAppKey).toHaveBeenCalledWith(
        'uoa_app_individual-product-key',
      );
      expect(entitlementService.getEffectiveTariffSnapshot).toHaveBeenCalledWith({
        request: {
          product: 'deepwater',
          organisationId: 'org-1',
          teamId: 'team-1',
          userId: 'user-1',
        },
        actorToken: 'signed-actor',
        credential,
      });
    });
  });

  it('rejects a missing actor after app-key authentication', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/effective-tariff',
        headers: { 'x-uoa-app-key': 'uoa_app_individual-product-key' },
        payload: {
          product: 'deepwater',
          organisation_id: 'org-1',
          team_id: 'team-1',
          user_id: 'user-1',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(entitlementService.getEffectiveTariffSnapshot).not.toHaveBeenCalled();
    });
  });

  it('rejects ambiguous product credentials instead of selecting one', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/effective-tariff',
        headers: {
          'x-uoa-app-key': 'uoa_app_first-product-key',
          authorization: 'Bearer uoa_app_second-product-key',
          'x-uoa-actor': 'signed-actor',
        },
        payload: {
          product: 'deepwater',
          organisation_id: 'org-1',
          team_id: 'team-1',
          user_id: 'user-1',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(appKeyService.verifyBillingAppKey).not.toHaveBeenCalled();
      expect(entitlementService.getEffectiveTariffSnapshot).not.toHaveBeenCalled();
    });
  });

  it('publishes only the tariff snapshot public key', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: '/billing/v1/jwks.json',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      const body = response.json<{ keys: Array<Record<string, unknown>> }>();
      expect(body.keys).toEqual([
        expect.objectContaining({
          kty: 'RSA',
          kid: 'tariff-snapshot-test',
          alg: 'RS256',
          use: 'sig',
        }),
      ]);
      expect(body.keys[0]).not.toHaveProperty('d');
    });
  });

  it('publishes only the dedicated Ledger collector assertion public key', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: '/billing/v1/service-jwks.json',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      const body = response.json<{ keys: Array<Record<string, unknown>> }>();
      expect(body.keys).toEqual([
        expect.objectContaining({
          kty: 'RSA',
          kid: 'billing-assertion-test',
          alg: 'RS256',
          use: 'sig',
        }),
      ]);
      expect(body.keys[0]).not.toHaveProperty('d');
      expect(body.keys[0].kid).not.toBe('tariff-snapshot-test');
    });
  });

  it('fails startup before serving when configured RSA material cannot be imported', async () => {
    const validPrivate = process.env.TARIFF_SNAPSHOT_PRIVATE_JWK;
    const validPublic = process.env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON;
    process.env.TARIFF_SNAPSHOT_PRIVATE_JWK = JSON.stringify({
      kty: 'RSA',
      kid: 'malformed-tariff-key',
      alg: 'RS256',
      use: 'sig',
      n: 'not-a-real-modulus',
      e: 'AQAB',
      d: 'not-a-real-private-exponent',
    });
    process.env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON = JSON.stringify({
      keys: [
        {
          kty: 'RSA',
          kid: 'malformed-tariff-key',
          alg: 'RS256',
          use: 'sig',
          n: 'not-a-real-modulus',
          e: 'AQAB',
        },
      ],
    });
    resetTariffSnapshotKeyCache();

    try {
      await expect(createApp()).rejects.toMatchObject({
        statusCode: 500,
        message: 'TARIFF_SNAPSHOT_KEY_INVALID',
      });
    } finally {
      if (validPrivate === undefined) {
        Reflect.deleteProperty(process.env, 'TARIFF_SNAPSHOT_PRIVATE_JWK');
      } else {
        process.env.TARIFF_SNAPSHOT_PRIVATE_JWK = validPrivate;
      }
      if (validPublic === undefined) {
        Reflect.deleteProperty(process.env, 'TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON');
      } else {
        process.env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON = validPublic;
      }
      resetTariffSnapshotKeyCache();
    }
  });
});
