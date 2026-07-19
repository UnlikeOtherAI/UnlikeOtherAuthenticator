import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { EffectiveTariffPayload } from '../../src/services/billing-entitlement.service.js';
import {
  assertEffectiveTariffPayloadBinding,
  getTariffSnapshotPublicJwks,
  resetTariffSnapshotKeyCache,
  signEffectiveTariffSnapshot,
} from '../../src/services/billing-snapshot.service.js';

const originalKey = process.env.TARIFF_SNAPSHOT_PRIVATE_JWK;
const originalPublicKeys = process.env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON;
const originalBaseUrl = process.env.PUBLIC_BASE_URL;
let retiredPrivateKey: CryptoKey;

beforeAll(async () => {
  process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
  process.env.PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';
  const current = await generateKeyPair('RS256', { extractable: true });
  const retired = await generateKeyPair('RS256', { extractable: true });
  retiredPrivateKey = retired.privateKey;
  const currentPrivateJwk = await exportJWK(current.privateKey);
  const currentPublicJwk = await exportJWK(current.publicKey);
  const retiredPublicJwk = await exportJWK(retired.publicKey);
  Object.assign(currentPrivateJwk, { kid: 'tariff-current', alg: 'RS256', use: 'sig' });
  Object.assign(currentPublicJwk, { kid: 'tariff-current', alg: 'RS256', use: 'sig' });
  Object.assign(retiredPublicJwk, { kid: 'tariff-retired', alg: 'RS256', use: 'sig' });
  process.env.TARIFF_SNAPSHOT_PRIVATE_JWK = JSON.stringify(currentPrivateJwk);
  process.env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON = JSON.stringify({
    keys: [retiredPublicJwk, currentPublicJwk],
  });
  resetTariffSnapshotKeyCache();
});

afterEach(() => {
  resetTariffSnapshotKeyCache();
});

const payload: EffectiveTariffPayload = {
  schema_version: 1,
  snapshot_id: 'snapshot_1',
  product: { id: 'service_1', identifier: 'deepwater' },
  authorized_party: { app_key_id: 'app_key_1' },
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
    collection_mode: 'stripe',
    markup_bps: 2_000,
    markup_percent: '20.00',
    usage_price_multiplier_bps: 12_000,
    monthly_subscription: { amount_minor: '2000', currency: 'USD' },
    usage_billing_enabled: true,
    payment_collection_enabled: true,
    raw_usage_preserved: true,
  },
  assignment: { scope: 'team', id: 'assignment_1' },
  issued_at: '2027-01-15T08:00:00.000Z',
  expires_at: '2027-01-15T08:05:00.000Z',
};

describe('effective tariff snapshot signing', () => {
  it('publishes current and retired public keys without private material', async () => {
    const jwks = await getTariffSnapshotPublicJwks();
    expect(jwks.keys.map((key) => key.kid)).toEqual(['tariff-retired', 'tariff-current']);
    for (const key of jwks.keys) {
      expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      expect(key).not.toHaveProperty('d');
    }
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
      kid: 'tariff-current',
      typ: 'uoa-tariff+jwt',
    });
    expect(claims).toMatchObject({
      sub: 'usr_1',
      jti: 'snapshot_1',
      schema_version: 1,
      product: { identifier: 'deepwater' },
      authorized_party: { app_key_id: 'app_key_1' },
      tariff: {
        id: 'tariff_1',
        version: 2,
        raw_usage_preserved: true,
      },
    });
  });

  it('keeps snapshots signed by the retired key verifiable during overlap', async () => {
    const issuedAt = Math.floor(Date.parse(payload.issued_at) / 1000);
    const snapshot = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'tariff-retired', typ: 'uoa-tariff+jwt' })
      .setIssuer('https://authentication.unlikeotherai.com')
      .setAudience('https://ledger.unlikeotherai.com')
      .setSubject(payload.subject.user_id)
      .setJti(payload.snapshot_id)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(retiredPrivateKey);

    await expect(
      jwtVerify(snapshot, createLocalJWKSet(await getTariffSnapshotPublicJwks()), {
        issuer: 'https://authentication.unlikeotherai.com',
        audience: 'https://ledger.unlikeotherai.com',
        currentDate: new Date(payload.issued_at),
      }),
    ).resolves.toMatchObject({
      protectedHeader: { kid: 'tariff-retired' },
    });
  });

  it('rejects a signed payload when the expected product, app key, or subject differs', () => {
    const expected = {
      productId: 'service_1',
      productIdentifier: 'deepwater',
      appKeyId: 'app_key_1',
      userId: 'usr_1',
      organisationId: 'org_1',
      teamId: 'team_1',
    };
    expect(() => assertEffectiveTariffPayloadBinding(payload, expected)).not.toThrow();
    expect(() =>
      assertEffectiveTariffPayloadBinding(payload, {
        ...expected,
        productId: 'service_deeptest',
        productIdentifier: 'deeptest',
      }),
    ).toThrowError('TARIFF_SNAPSHOT_BINDING_MISMATCH');
    expect(() =>
      assertEffectiveTariffPayloadBinding(payload, {
        ...expected,
        appKeyId: 'app_key_deeptest',
      }),
    ).toThrowError('TARIFF_SNAPSHOT_BINDING_MISMATCH');
    expect(() =>
      assertEffectiveTariffPayloadBinding(payload, {
        ...expected,
        userId: 'usr_other',
      }),
    ).toThrowError('TARIFF_SNAPSHOT_BINDING_MISMATCH');
    expect(() =>
      assertEffectiveTariffPayloadBinding(payload, {
        ...expected,
        organisationId: 'org_other',
      }),
    ).toThrowError('TARIFF_SNAPSHOT_BINDING_MISMATCH');
    expect(() =>
      assertEffectiveTariffPayloadBinding(payload, {
        ...expected,
        teamId: 'team_other',
      }),
    ).toThrowError('TARIFF_SNAPSHOT_BINDING_MISMATCH');
  });
});

afterAll(() => {
  if (originalKey === undefined) {
    Reflect.deleteProperty(process.env, 'TARIFF_SNAPSHOT_PRIVATE_JWK');
  } else {
    process.env.TARIFF_SNAPSHOT_PRIVATE_JWK = originalKey;
  }
  if (originalPublicKeys === undefined) {
    Reflect.deleteProperty(process.env, 'TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON');
  } else {
    process.env.TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON = originalPublicKeys;
  }
  if (originalBaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'PUBLIC_BASE_URL');
  } else {
    process.env.PUBLIC_BASE_URL = originalBaseUrl;
  }
  resetTariffSnapshotKeyCache();
});
