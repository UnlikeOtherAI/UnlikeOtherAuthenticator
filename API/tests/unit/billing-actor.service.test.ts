import { BillingAppKeyPurpose } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { verifyBillingActor } from '../../src/services/billing-actor.service.js';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';

let privateKey: CryptoKey;
let unrelatedPrivateKey: CryptoKey;
let credential: VerifiedBillingAppKey;

const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'usr_1',
};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  unrelatedPrivateKey = (await generateKeyPair('RS256', { extractable: true })).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'ledger-actor-1', alg: 'RS256', use: 'sig' });
  credential = {
    id: 'key_1',
    purpose: BillingAppKeyPurpose.ENTITLEMENT,
    actorIssuer: 'https://ledger.unlikeotherai.com',
    actorAudience: 'https://authentication.unlikeotherai.com/billing/v1/effective-tariff',
    actorKeyId: 'ledger-actor-1',
    actorPublicJwk: jwk,
    checkoutReturnOrigins: [],
    service: {
      id: 'service_1',
      identifier: 'deepwater',
      name: 'DeepWater',
    },
  };
});

async function actorToken(
  overrides: Record<string, unknown> = {},
  options: {
    issuer?: string;
    audience?: string;
    subject?: string;
    kid?: string;
    signingKey?: CryptoKey;
  } = {},
): Promise<string> {
  const now = 1_800_000_000;
  return new SignJWT({
    product: request.product,
    organisation_id: request.organisationId,
    team_id: request.teamId,
    tv: 4,
    ...overrides,
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: options.kid ?? 'ledger-actor-1',
      typ: 'uoa-actor+jwt',
    })
    .setIssuer(options.issuer ?? credential.actorIssuer)
    .setAudience(options.audience ?? credential.actorAudience)
    .setSubject(options.subject ?? request.userId)
    .setJti('actor-jti-1')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(options.signingKey ?? privateKey);
}

describe('billing actor verification', () => {
  it('accepts a short-lived actor bound to the credential and request', async () => {
    const actor = await verifyBillingActor(
      { token: await actorToken(), credential, request },
      { now: () => 1_800_000_000 },
    );
    expect(actor).toMatchObject({
      sub: 'usr_1',
      product: 'deepwater',
      organisation_id: 'org_1',
      team_id: 'team_1',
      tv: 4,
      jti: 'actor-jti-1',
    });
  });

  it('rejects actor/request identity mismatches', async () => {
    await expect(
      verifyBillingActor(
        {
          token: await actorToken({ team_id: 'team_other' }),
          credential,
          request,
        },
        { now: () => 1_800_000_000 },
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_BILLING_ACTOR',
    });
  });

  it('rejects assertions longer than sixty seconds', async () => {
    const now = 1_800_000_000;
    const token = await new SignJWT({
      product: request.product,
      organisation_id: request.organisationId,
      team_id: request.teamId,
      tv: 4,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'ledger-actor-1' })
      .setIssuer(credential.actorIssuer)
      .setAudience(credential.actorAudience)
      .setSubject(request.userId)
      .setJti('actor-jti-long')
      .setIssuedAt(now)
      .setExpirationTime(now + 61)
      .sign(privateKey);

    await expect(
      verifyBillingActor({ token, credential, request }, { now: () => now }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a missing or invalid credential epoch', async () => {
    await expect(
      verifyBillingActor(
        { token: await actorToken({ tv: undefined }), credential, request },
        { now: () => 1_800_000_000 },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_BILLING_ACTOR' });
    await expect(
      verifyBillingActor(
        { token: await actorToken({ tv: -1 }), credential, request },
        { now: () => 1_800_000_000 },
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_BILLING_ACTOR' });
  });

  it('rejects every credential or UOA identity binding mismatch', async () => {
    const tokens = await Promise.all([
      actorToken({}, { issuer: 'https://other-issuer.example.com' }),
      actorToken({}, { audience: 'https://other-audience.example.com' }),
      actorToken({}, { subject: 'usr_other' }),
      actorToken({}, { kid: 'other-kid' }),
      actorToken({}, { signingKey: unrelatedPrivateKey }),
      actorToken({ organisation_id: 'org_other' }),
    ]);

    for (const token of tokens) {
      await expect(
        verifyBillingActor({ token, credential, request }, { now: () => 1_800_000_000 }),
      ).rejects.toMatchObject({
        statusCode: 401,
        message: 'INVALID_BILLING_ACTOR',
      });
    }
  });
});
