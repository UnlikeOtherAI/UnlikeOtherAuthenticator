import { BillingAppKeyPurpose } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyBillingActor } from '../../src/services/billing-actor.service.js';
import type { BillingActorEndpoint } from '../../src/services/billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';

const PUBLIC_BASE_URL = 'https://authentication.unlikeotherai.com';
const LEGACY_AUDIENCE = `${PUBLIC_BASE_URL}/billing/v1/effective-tariff`;

let privateKey: CryptoKey;
let unrelatedPrivateKey: CryptoKey;
let credential: VerifiedBillingAppKey;

const request = {
  product: 'deepwater',
  organisationId: 'org_1',
  teamId: 'team_1',
  userId: 'usr_1',
};

const envNames = ['PUBLIC_BASE_URL', 'BILLING_ACTOR_AUDIENCE_MODE'] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]])) as Record<
  (typeof envNames)[number],
  string | undefined
>;

beforeAll(async () => {
  process.env.PUBLIC_BASE_URL = PUBLIC_BASE_URL;
  Reflect.deleteProperty(process.env, 'BILLING_ACTOR_AUDIENCE_MODE');

  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  unrelatedPrivateKey = (await generateKeyPair('RS256', { extractable: true })).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'ledger-actor-1', alg: 'RS256', use: 'sig' });
  credential = {
    id: 'key_1',
    purpose: BillingAppKeyPurpose.ENTITLEMENT,
    actorIssuer: 'https://ledger.unlikeotherai.com',
    actorAudience: LEGACY_AUDIENCE,
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

afterAll(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
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
    .setAudience(options.audience ?? LEGACY_AUDIENCE)
    .setSubject(options.subject ?? request.userId)
    .setJti('actor-jti-1')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(options.signingKey ?? privateKey);
}

function verify(token: string, endpoint: BillingActorEndpoint = '/billing/v1/effective-tariff') {
  return verifyBillingActor({ token, credential, endpoint, request }, { now: () => 1_800_000_000 });
}

describe('billing actor verification', () => {
  it('accepts a short-lived actor bound to the credential and request', async () => {
    const actor = await verify(await actorToken());
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
    await expect(verify(await actorToken({ team_id: 'team_other' }))).rejects.toMatchObject({
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
      .setAudience(LEGACY_AUDIENCE)
      .setSubject(request.userId)
      .setJti('actor-jti-long')
      .setIssuedAt(now)
      .setExpirationTime(now + 61)
      .sign(privateKey);

    await expect(verify(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a missing or invalid credential epoch', async () => {
    await expect(verify(await actorToken({ tv: undefined }))).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_BILLING_ACTOR',
    });
    await expect(verify(await actorToken({ tv: -1 }))).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_BILLING_ACTOR',
    });
  });

  it('rejects every credential or UOA identity binding mismatch', async () => {
    const tokens = await Promise.all([
      actorToken({}, { issuer: 'https://other-issuer.example.com' }),
      actorToken({}, { subject: 'usr_other' }),
      actorToken({}, { kid: 'other-kid' }),
      actorToken({}, { signingKey: unrelatedPrivateKey }),
      actorToken({ organisation_id: 'org_other' }),
    ]);

    for (const token of tokens) {
      await expect(verify(token)).rejects.toMatchObject({
        statusCode: 401,
        message: 'INVALID_BILLING_ACTOR',
      });
    }
  });

  it('rejects an audience belonging to neither this endpoint nor this deployment', async () => {
    await expect(
      verify(await actorToken({}, { audience: 'https://other-audience.example.com' })),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: 'BILLING_ACTOR_AUDIENCE_MISMATCH',
    });
  });
});

describe('billing actor endpoint audience', () => {
  it('accepts an assertion whose audience names the exact endpoint it is presented to', async () => {
    const token = await actorToken(
      {},
      { audience: `${PUBLIC_BASE_URL}/billing/v2/customer-statement` },
    );
    await expect(verify(token, '/billing/v2/customer-statement')).resolves.toMatchObject({
      sub: 'usr_1',
    });
  });

  it('refuses an endpoint-bound assertion replayed against a different endpoint', async () => {
    // The whole point: a read assertion must not spend at a funding endpoint
    // inside its sixty-second life.
    const token = await actorToken({}, { audience: `${PUBLIC_BASE_URL}/billing/v1/credits` });
    await expect(verify(token, '/billing/v1/credits/top-up-checkout')).rejects.toMatchObject({
      statusCode: 401,
      message: 'BILLING_ACTOR_AUDIENCE_MISMATCH',
    });
  });

  it('accepts the legacy constant audience at any endpoint while the deployment warns', async () => {
    process.env.BILLING_ACTOR_AUDIENCE_MODE = 'warn';
    try {
      await expect(
        verify(await actorToken(), '/billing/v1/cancellation/confirm'),
      ).resolves.toMatchObject({ sub: 'usr_1' });
    } finally {
      Reflect.deleteProperty(process.env, 'BILLING_ACTOR_AUDIENCE_MODE');
    }
  });

  it('defaults to warn when the deployment sets no mode', async () => {
    expect(process.env.BILLING_ACTOR_AUDIENCE_MODE).toBeUndefined();
    await expect(
      verify(await actorToken(), '/billing/v1/stripe/portal-session'),
    ).resolves.toMatchObject({ sub: 'usr_1' });
  });

  it('refuses the legacy constant audience once the deployment enforces', async () => {
    process.env.BILLING_ACTOR_AUDIENCE_MODE = 'enforce';
    try {
      await expect(
        verify(await actorToken(), '/billing/v1/cancellation/confirm'),
      ).rejects.toMatchObject({
        statusCode: 401,
        message: 'BILLING_ACTOR_AUDIENCE_MISMATCH',
      });
    } finally {
      Reflect.deleteProperty(process.env, 'BILLING_ACTOR_AUDIENCE_MODE');
    }
  });

  it('still accepts an endpoint-bound assertion under enforce', async () => {
    process.env.BILLING_ACTOR_AUDIENCE_MODE = 'enforce';
    try {
      const token = await actorToken(
        {},
        { audience: `${PUBLIC_BASE_URL}/billing/v1/cancellation/confirm` },
      );
      await expect(verify(token, '/billing/v1/cancellation/confirm')).resolves.toMatchObject({
        sub: 'usr_1',
      });
    } finally {
      Reflect.deleteProperty(process.env, 'BILLING_ACTOR_AUDIENCE_MODE');
    }
  });

  it('never honours a legacy audience pointing at another origin', async () => {
    const foreign: VerifiedBillingAppKey = {
      ...credential,
      actorAudience: 'https://attacker.example.com/billing/v1/effective-tariff',
    };
    const token = await actorToken(
      {},
      { audience: 'https://attacker.example.com/billing/v1/effective-tariff' },
    );
    await expect(
      verifyBillingActor(
        {
          token,
          credential: foreign,
          endpoint: '/billing/v1/credits',
          request,
        },
        { now: () => 1_800_000_000 },
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: 'BILLING_ACTOR_AUDIENCE_MISMATCH',
    });
  });

  it('rejects an array audience even when it contains the endpoint', async () => {
    const now = 1_800_000_000;
    const token = await new SignJWT({
      product: request.product,
      organisation_id: request.organisationId,
      team_id: request.teamId,
      tv: 4,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'ledger-actor-1' })
      .setIssuer(credential.actorIssuer)
      .setAudience([`${PUBLIC_BASE_URL}/billing/v1/credits`, 'https://elsewhere.example.com'])
      .setSubject(request.userId)
      .setJti('actor-jti-array')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);

    await expect(verify(token, '/billing/v1/credits')).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_BILLING_ACTOR',
    });
  });
});
