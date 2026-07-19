import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createBillingAppKey,
  normalizeCheckoutReturnOrigins,
  verifyBillingAppKey,
} from '../../src/services/billing-app-key.service.js';
import { BILLING_APP_KEY_PREFIX } from '../../src/utils/billing-app-key.js';

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalSharedSecret = process.env.SHARED_SECRET;
const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const { publicKey } = await generateKeyPair('RS256', { extractable: true });
  publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { kid: 'ledger-shared-actor', alg: 'RS256', use: 'sig' });
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalSharedSecret === undefined) {
    Reflect.deleteProperty(process.env, 'SHARED_SECRET');
  } else {
    process.env.SHARED_SECRET = originalSharedSecret;
  }
  if (originalPublicBaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
  } else {
    process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
  }
});

describe('product-dedicated billing app keys', () => {
  it('returns plaintext once while persisting only a digest and actor binding', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';
    const createdAt = new Date('2026-07-19T00:00:00.000Z');
    let persisted: Record<string, unknown> = {};
    const prisma = {
      billingService: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'service_1',
          identifier: 'deepwater',
          active: true,
        }),
      },
      billingAppKey: {
        create: vi.fn().mockImplementation(({ data }) => {
          persisted = data;
          return {
            id: 'key_1',
            serviceId: 'service_1',
            name: data.name,
            keyPrefix: data.keyPrefix,
            actorIssuer: data.actorIssuer,
            actorAudience: data.actorAudience,
            actorKeyId: data.actorKeyId,
            checkoutReturnOrigins: data.checkoutReturnOrigins,
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
            createdByEmail: 'admin@example.com',
            createdAt,
          };
        }),
      },
      adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: async (run: (tx: unknown) => unknown) => run(prisma),
    };

    const result = await createBillingAppKey(
      {
        serviceId: 'service_1',
        name: 'DeepWater production',
        actorIssuer: 'https://ledger.unlikeotherai.com',
        actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
        actorPublicJwk: publicJwk,
        checkoutReturnOrigins: ['https://app.nessie.works'],
        createdBy: { userId: 'admin_1', email: 'admin@example.com' },
      },
      { prisma: prisma as never },
    );

    expect(result.plaintext).toMatch(new RegExp(`^${BILLING_APP_KEY_PREFIX}`));
    expect(persisted).not.toHaveProperty('key');
    expect(persisted).not.toHaveProperty('plaintext');
    expect(persisted.secretDigest).toEqual(expect.any(String));
    expect(persisted.secretDigest).not.toBe(result.plaintext);
    expect(persisted).toMatchObject({
      serviceId: 'service_1',
      actorIssuer: 'https://ledger.unlikeotherai.com',
      actorKeyId: 'ledger-shared-actor',
      checkoutReturnOrigins: ['https://app.nessie.works'],
    });
  });

  it('rejects an actor audience for any endpoint other than this UOA tariff API', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';

    await expect(
      createBillingAppKey(
        {
          serviceId: 'service_1',
          name: 'Wrong audience',
          actorIssuer: 'https://ledger.unlikeotherai.com',
          actorAudience: 'https://authentication.unlikeotherai.com/some-other-api',
          actorPublicJwk: publicJwk,
          checkoutReturnOrigins: [],
          createdBy: { email: 'admin@example.com' },
        },
        { prisma: {} as never },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'INVALID_ACTOR_AUDIENCE',
    });
  });

  it('authenticates an active key only for its bound product', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.DATABASE_URL = 'postgresql://configured';
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      billingAppKey: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'key_1',
          actorIssuer: 'https://ledger.unlikeotherai.com',
          actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
          actorKeyId: 'ledger-shared-actor',
          actorPublicJwk: publicJwk,
          checkoutReturnOrigins: [],
          revokedAt: null,
          expiresAt: null,
          service: {
            id: 'service_1',
            identifier: 'deepwater',
            name: 'DeepWater',
            active: true,
          },
        }),
        update,
      },
    };
    const verified = await verifyBillingAppKey('uoa_app_example', {
      prisma: prisma as never,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    expect(verified.service).toEqual({
      id: 'service_1',
      identifier: 'deepwater',
      name: 'DeepWater',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'key_1' },
      data: { lastUsedAt: new Date('2026-07-19T00:00:00.000Z') },
    });
  });

  it.each([
    {
      name: 'revoked',
      revokedAt: new Date('2026-07-18T00:00:00.000Z'),
      expiresAt: null,
      serviceActive: true,
    },
    {
      name: 'expired',
      revokedAt: null,
      expiresAt: new Date('2026-07-18T00:00:00.000Z'),
      serviceActive: true,
    },
    {
      name: 'inactive product',
      revokedAt: null,
      expiresAt: null,
      serviceActive: false,
    },
  ])('rejects a $name app key', async ({ revokedAt, expiresAt, serviceActive }) => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.DATABASE_URL = 'postgresql://configured';
    const update = vi.fn();
    const prisma = {
      billingAppKey: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'key_1',
          actorIssuer: 'https://ledger.unlikeotherai.com',
          actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
          actorKeyId: 'ledger-shared-actor',
          actorPublicJwk: publicJwk,
          checkoutReturnOrigins: [],
          revokedAt,
          expiresAt,
          service: {
            id: 'service_1',
            identifier: 'deepwater',
            name: 'DeepWater',
            active: serviceActive,
          },
        }),
        update,
      },
    };

    await expect(
      verifyBillingAppKey('uoa_app_example', {
        prisma: prisma as never,
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(update).not.toHaveBeenCalled();
  });

  it('canonicalizes exact HTTPS checkout return origins and rejects paths', () => {
    expect(
      normalizeCheckoutReturnOrigins([
        'https://app.nessie.works/',
        'https://app.nessie.works',
        'https://water.example.com',
      ]),
    ).toEqual(['https://app.nessie.works', 'https://water.example.com']);
    expect(() =>
      normalizeCheckoutReturnOrigins(['https://app.nessie.works/billing']),
    ).toThrow('INVALID_CHECKOUT_RETURN_ORIGINS');
    expect(() =>
      normalizeCheckoutReturnOrigins(['http://app.nessie.works']),
    ).toThrow('INVALID_CHECKOUT_RETURN_ORIGINS');
  });
});
