import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifyChainedSubjectAccessToken } from '../../src/services/confidential-chained-token-exchange.service.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';

const issuer = 'https://authentication.unlikeotherai.com';
const sourceDomain = 'api.nessie.works';
const callerDomain = 'api.deepsignal.live';
const callerAudience = `https://${callerDomain}`;
const userId = 'usr_1';

let privateKey: KeyLike;
let privateJwk: JWK;
let keyId: string;

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK: process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function defaultOrg() {
  return {
    org_id: 'org_1',
    org_role: 'member',
    teams: ['team_1', 'team_2'],
    team_roles: { team_1: 'member', team_2: 'admin' },
  };
}

async function signInboundToken(
  overrides: {
    actor?: unknown;
    audience?: string;
    expiresInSeconds?: number;
    issuer?: string;
    omitActive?: boolean;
    omitOrg?: boolean;
    org?: unknown;
    product?: string;
    scope?: string;
    sourceDomain?: string;
    typ?: string;
    azp?: string;
  } = {},
): Promise<{ now: number; token: string }> {
  const now = Math.floor(Date.now() / 1000);
  const inboundSource = overrides.sourceDomain ?? sourceDomain;
  const payload: Record<string, unknown> = {
    tv: 0,
    email: 'nessie-user@example.com',
    source_domain: inboundSource,
    azp: overrides.azp ?? inboundSource,
    product: overrides.product ?? 'nessie',
    scope: overrides.scope ?? 'ai.invoke',
  };
  if (!overrides.omitOrg) {
    payload.org = Object.prototype.hasOwnProperty.call(overrides, 'org')
      ? overrides.org
      : defaultOrg();
  }
  if (!overrides.omitActive) {
    payload.active = { orgId: 'org_1', teamId: 'team_1' };
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'actor')) {
    payload.act = overrides.actor;
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({
      alg: 'RS256',
      kid: keyId,
      typ: overrides.typ ?? 'at+jwt',
    })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? callerAudience)
    .setSubject(userId)
    .setJti('uoa-inbound-jti')
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expiresInSeconds ?? 240))
    .sign(privateKey);

  return { now, token };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  privateJwk = await exportJWK(pair.privateKey);
  keyId = 'uoa-chained-exchange-test';
  Object.assign(privateJwk, { kid: keyId, alg: 'RS256', use: 'sig' });
});

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/authenticator-test';
  process.env.PUBLIC_BASE_URL = issuer;
  process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(privateJwk);
  resetAccessTokenKeyCache();
});

afterAll(() => {
  restoreEnv('DATABASE_URL');
  restoreEnv('PUBLIC_BASE_URL');
  restoreEnv('MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK');
  resetAccessTokenKeyCache();
});

describe('chained UOA access-token verification', () => {
  it('accepts a UOA at+jwt bound to the authenticated caller origin', async () => {
    const { now, token } = await signInboundToken();
    const subject = await verifyChainedSubjectAccessToken(
      {
        subjectToken: token,
        callerAudience,
        issuer,
      },
      { now: () => now },
    );

    expect(subject).toMatchObject({
      sub: userId,
      tv: 0,
      source_domain: sourceDomain,
      azp: sourceDomain,
      product: 'nessie',
      scope: 'ai.invoke',
      org: { org_id: 'org_1', teams: ['team_1', 'team_2'] },
      active: { orgId: 'org_1', teamId: 'team_1' },
    });
  });

  it('rejects the wrong audience, issuer, token type, or source binding', async () => {
    const variants = [
      await signInboundToken({ audience: 'https://other.example' }),
      await signInboundToken({ issuer: 'https://evil.example' }),
      await signInboundToken({ typ: 'JWT' }),
      await signInboundToken({ azp: 'api.other.example' }),
    ];

    for (const { now, token } of variants) {
      await expect(
        verifyChainedSubjectAccessToken(
          { subjectToken: token, callerAudience, issuer },
          { now: () => now },
        ),
      ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    }
  });

  it('requires non-null, internally consistent organisation and team provenance', async () => {
    const variants = [
      await signInboundToken({ omitActive: true }),
      await signInboundToken({ omitOrg: true }),
      await signInboundToken({
        org: {
          ...defaultOrg(),
          org_id: 'org_other',
        },
      }),
      await signInboundToken({
        org: {
          ...defaultOrg(),
          teams: ['team_2'],
          team_roles: { team_2: 'admin' },
        },
      }),
    ];

    for (const { now, token } of variants) {
      await expect(
        verifyChainedSubjectAccessToken(
          { subjectToken: token, callerAudience, issuer },
          { now: () => now },
        ),
      ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    }
  });

  it('accepts only canonical supported inbound scopes and a bounded actor chain', async () => {
    for (const scope of ['ai.invoke ai.invoke', 'unknown.scope']) {
      const { now, token } = await signInboundToken({ scope });
      await expect(
        verifyChainedSubjectAccessToken(
          { subjectToken: token, callerAudience, issuer },
          { now: () => now },
        ),
      ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    }

    const { now, token } = await signInboundToken({
      actor: { sub: 'api.origin.example', product: 'origin' },
    });
    await expect(
      verifyChainedSubjectAccessToken(
        { subjectToken: token, callerAudience, issuer },
        { now: () => now },
      ),
    ).resolves.toMatchObject({
      act: { sub: 'api.origin.example', product: 'origin' },
    });

    let oversizedActor: unknown = { sub: 'api.origin-0.example', product: 'origin' };
    for (let index = 1; index < 8; index += 1) {
      oversizedActor = {
        sub: `api.origin-${index}.example`,
        product: 'origin',
        act: oversizedActor,
      };
    }
    const oversized = await signInboundToken({ actor: oversizedActor });
    await expect(
      verifyChainedSubjectAccessToken(
        { subjectToken: oversized.token, callerAudience, issuer },
        { now: () => oversized.now },
      ),
    ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
  });
});
