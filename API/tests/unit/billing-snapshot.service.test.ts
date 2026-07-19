import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { EffectiveTariffPayload } from '../../src/services/billing-entitlement.service.js';
import {
  getTariffSnapshotPublicJwks,
  resetTariffSnapshotKeyCache,
  signEffectiveTariffSnapshot,
} from '../../src/services/billing-snapshot.service.js';

const originalKey = process.env.TARIFF_SNAPSHOT_PRIVATE_JWK;
const originalBaseUrl = process.env.PUBLIC_BASE_URL;

beforeAll(async () => {
  process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
  process.env.PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  Object.assign(jwk, { kid: 'tariff-test-key', alg: 'RS256', use: 'sig' });
  process.env.TARIFF_SNAPSHOT_PRIVATE_JWK = JSON.stringify(jwk);
  resetTariffSnapshotKeyCache();
});

afterEach(() => {
  resetTariffSnapshotKeyCache();
});

const payload: EffectiveTariffPayload = {
  schema_version: 1,
  snapshot_id: 'snapshot_1',
  product: { id: 'service_1', identifier: 'deepwater' },
  subject: {
    user_id: 'usr_1',
    organisation_id: 'org_1',
    team_id: 'team_1',
  },
  tariff: {
    id: 'tariff_1',
    key: 'standard',
    version: 2,
    mode: 'standard',
    markup_bps: 2_000,
    markup_percent: '20.00',
    usage_price_multiplier_bps: 12_000,
    monthly_subscription: { amount_minor: '2000', currency: 'USD' },
    usage_billing_enabled: true,
    raw_usage_preserved: true,
  },
  assignment: { scope: 'team', id: 'assignment_1' },
  issued_at: '2027-01-15T08:00:00.000Z',
  expires_at: '2027-01-15T08:05:00.000Z',
};

describe('effective tariff snapshot signing', () => {
  it('publishes only the public half of the dedicated key', async () => {
    const jwks = await getTariffSnapshotPublicJwks();
    expect(jwks.keys[0]).toMatchObject({
      kty: 'RSA',
      kid: 'tariff-test-key',
      alg: 'RS256',
      use: 'sig',
    });
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('signs a Ledger-audience tariff JWT with immutable versioned claims', async () => {
    const issuedAt = Math.floor(Date.parse(payload.issued_at) / 1000);
    const expiresAt = Math.floor(Date.parse(payload.expires_at) / 1000);
    const snapshot = await signEffectiveTariffSnapshot({
      payload,
      audience: 'https://ledger.unlikeotherai.com',
      issuedAtEpochSeconds: issuedAt,
      expiresAtEpochSeconds: expiresAt,
    });
    const { payload: claims, protectedHeader } = await jwtVerify(
      snapshot,
      createLocalJWKSet(await getTariffSnapshotPublicJwks()),
      {
        issuer: 'https://authentication.unlikeotherai.com',
        audience: 'https://ledger.unlikeotherai.com',
        currentDate: new Date(payload.issued_at),
      },
    );
    expect(protectedHeader).toMatchObject({
      alg: 'RS256',
      kid: 'tariff-test-key',
      typ: 'uoa-tariff+jwt',
    });
    expect(claims).toMatchObject({
      sub: 'usr_1',
      jti: 'snapshot_1',
      schema_version: 1,
      product: { identifier: 'deepwater' },
      tariff: {
        id: 'tariff_1',
        version: 2,
        raw_usage_preserved: true,
      },
    });
  });
});

afterAll(() => {
  if (originalKey === undefined) {
    Reflect.deleteProperty(process.env, 'TARIFF_SNAPSHOT_PRIVATE_JWK');
  } else {
    process.env.TARIFF_SNAPSHOT_PRIVATE_JWK = originalKey;
  }
  if (originalBaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
  } else {
    process.env.PUBLIC_BASE_URL = originalBaseUrl;
  }
  resetTariffSnapshotKeyCache();
});
