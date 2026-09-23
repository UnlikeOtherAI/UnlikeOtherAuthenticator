import { randomUUID } from 'node:crypto';

import { ConfidentialDelegationScope } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { exchangeConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { cleanClientDomains, seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

// The partner JWKS fetch is the one network hop the exchange makes beyond the config fetch; serve
// the source product's assertion key from it. Everything else — config verification, domain-hash
// auth, the delegation mapping, the policy and epoch locks, and the error handler — is real.
const partnerJwks = vi.hoisted(() => ({ keys: [] as unknown[] }));
vi.mock('../../src/services/jwks-fetch.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/jwks-fetch.service.js')>()),
  fetchPartnerJwks: vi.fn(async () => partnerJwks),
}));
// A pass-through spy, so a test can read the internal code the real service threw behind a
// production body that deliberately withholds it.
vi.mock('../../src/services/confidential-token-exchange.service.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/services/confidential-token-exchange.service.js')
    >();
  return {
    ...actual,
    exchangeConfidentialSubjectToken: vi.fn(actual.exchangeConfidentialSubjectToken),
  };
});

const hasDatabase = Boolean(process.env.DATABASE_URL);
const issuer = 'https://authentication.unlikeotherai.com';
const sourceDomain = 'nessie-contract.example.com';
const configUrl = `https://${sourceDomain}/auth/config`;
const ledgerResource = 'https://ledger.unlikeotherai.com';

type App = Awaited<ReturnType<typeof createApp>>;

describe.skipIf(!hasDatabase)('confidential exchange refusal codes (production mode)', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let assertionKey: KeyLike;
  let bearer: string;
  let app: App;
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DEBUG_ENABLED: process.env.DEBUG_ENABLED,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
  };

  beforeAll(async () => {
    const assertionPair = await generateKeyPair('RS256', { extractable: true });
    assertionKey = assertionPair.privateKey;
    const assertionJwk: JWK = await exportJWK(assertionPair.publicKey);
    Object.assign(assertionJwk, { kid: 'nessie-assertion-key', alg: 'RS256', use: 'sig' });
    partnerJwks.keys = [assertionJwk];

    const signerPair = await generateKeyPair('RS256', { extractable: true });
    const signerJwk = await exportJWK(signerPair.privateKey);
    Object.assign(signerJwk, { kid: 'uoa-resource-token-key', alg: 'RS256', use: 'sig' });

    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.PUBLIC_BASE_URL = issuer;
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(signerJwk);
    resetAccessTokenKeyCache();
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    resetAccessTokenKeyCache();
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    // Production mode: only PRODUCTION_PUBLIC_ERROR_CODES survive into the JSON body.
    Reflect.deleteProperty(process.env, 'DEBUG_ENABLED');
    await handle.prisma.confidentialAssertionUse.deleteMany();
    await handle.prisma.confidentialDelegationMapping.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
    await cleanClientDomains(handle.prisma);
    bearer = await seedDomainSecret(handle.prisma, sourceDomain);
    const client = await handle.prisma.clientDomain.findUniqueOrThrow({
      where: { domain: sourceDomain },
      select: { id: true },
    });
    await handle.prisma.confidentialDelegationMapping.create({
      data: {
        clientDomainId: client.id,
        product: 'nessie',
        resource: ledgerResource,
        scopes: [ConfidentialDelegationScope.AI_INVOKE],
      },
    });

    // A product without team support: org features off and no cross-product team policy.
    const configJwt = await signTestConfigJwt(
      baseClientConfigPayload({
        domain: sourceDomain,
        redirect_urls: [`https://${sourceDomain}/oauth/callback`],
        jwks_url: `https://${sourceDomain}/.well-known/jwks.json`,
        org_features: { enabled: false },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(configJwt)));
    app = await createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  async function seedUser(params: { tokenVersion: number; domainRole: boolean }) {
    const user = await handle.prisma.user.create({
      data: {
        email: `contract-${randomUUID()}@example.com`,
        userKey: randomUUID(),
        tokenVersion: params.tokenVersion,
      },
      select: { id: true },
    });
    if (params.domainRole) {
      await handle.prisma.domainRole.create({
        data: { domain: sourceDomain, userId: user.id, role: 'USER' },
      });
    }
    return user.id;
  }

  async function exchange(params: { sub: string; tv: number; active?: unknown }) {
    const now = Math.floor(Date.now() / 1000);
    const subjectToken = await new SignJWT({
      source_domain: sourceDomain,
      tv: params.tv,
      ...(params.active ? { active: params.active } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'nessie-assertion-key', typ: 'JWT' })
      .setIssuer(sourceDomain)
      .setAudience(`${issuer}/auth/token`)
      .setSubject(params.sub)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(assertionKey);
    return app.inject({
      method: 'POST',
      url: `/auth/token?config_url=${encodeURIComponent(configUrl)}`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: subjectToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        product: 'nessie',
        resource: ledgerResource,
        scope: 'ai.invoke',
      },
    });
  }

  it('issues a token for a current subject (the refusals below are not setup failures)', async () => {
    const sub = await seedUser({ tokenVersion: 1, domainRole: true });
    const response = await exchange({ sub, tv: 1 });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ token_type: 'Bearer', scope: 'ai.invoke' });
  });

  it('answers a moved credential epoch with exactly the public subject code', async () => {
    const sub = await seedUser({ tokenVersion: 1, domainRole: true });
    const response = await exchange({ sub, tv: 0 });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: 'Request failed',
      code: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN',
    });
  });

  it('gives a lost source-domain role and an unknown user the identical body', async () => {
    const withoutRole = await seedUser({ tokenVersion: 0, domainRole: false });
    const expected = { error: 'Request failed', code: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN' };

    for (const sub of [withoutRole, `unknown-${randomUUID()}`]) {
      const response = await exchange({ sub, tv: 0 });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toStrictEqual(expected);
    }
  });

  it('keeps the product configuration refusal generic and independent of the subject', async () => {
    const current = await seedUser({ tokenVersion: 0, domainRole: true });
    const moved = await seedUser({ tokenVersion: 1, domainRole: true });
    const active = { orgId: 'org_contract', teamId: 'team_contract' };

    // Same bare body whether the subject is current, has a moved epoch, or does not exist: the
    // refusal is decided before any subject lookup and reveals nothing about the subject.
    for (const sub of [current, moved, `unknown-${randomUUID()}`]) {
      const response = await exchange({ sub, tv: 0, active });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toStrictEqual({ error: 'Request failed' });
      await expect(
        vi.mocked(exchangeConfidentialSubjectToken).mock.results.at(-1)?.value,
      ).rejects.toMatchObject({
        statusCode: 403,
        message: 'TOKEN_EXCHANGE_TEAM_CONTEXT_UNSUPPORTED',
      });
    }
  });
});
