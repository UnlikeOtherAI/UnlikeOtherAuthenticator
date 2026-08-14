import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifyChainedSubjectAccessToken } from '../../src/services/confidential-chained-token-exchange.service.js';
import {
  resetAccessTokenKeyCache,
  signConfidentialAccessToken,
} from '../../src/services/oauth/access-token.service.js';

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

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  privateJwk = await exportJWK(pair.privateKey);
  keyId = 'uoa-chained-verify-test';
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

function defaultOrg() {
  return {
    org_id: 'org_1',
    tenant_slug: 'nessie',
    org_role: 'member',
    teams: ['team_1', 'team_2'],
    team_roles: { team_1: 'member', team_2: 'admin' },
  };
}

async function signInboundToken(options: { omitEmail?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    tv: 0,
    source_domain: sourceDomain,
    azp: sourceDomain,
    product: 'nessie',
    scope: 'ai.invoke',
    org: defaultOrg(),
    active: { orgId: 'org_1', teamId: 'team_1' },
  };
  if (!options.omitEmail) payload.email = 'nessie-user@example.com';

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(callerAudience)
    .setSubject(userId)
    .setJti('uoa-inbound-jti')
    .setIssuedAt(now)
    .setExpirationTime(now + 240)
    .sign(privateKey);

  return { now, token };
}

describe('chained subject access-token verification', () => {
  it('verifies an actual no-email inbound token: stable sub, epoch, and workspace suffice', async () => {
    // UOA-issued identity/membership tokens omit email; the inbound schema
    // accepts them because stable sub + credential epoch + re-resolved
    // workspace are the authority, never the advisory email claim.
    const { now, token } = await signInboundToken({ omitEmail: true });

    const verified = await verifyChainedSubjectAccessToken(
      { subjectToken: token, callerAudience, issuer },
      { now: () => now },
    );

    expect(verified.email).toBeUndefined();
    expect(verified).toMatchObject({
      iss: issuer,
      aud: callerAudience,
      sub: userId,
      tv: 0,
      source_domain: sourceDomain,
      azp: sourceDomain,
      product: 'nessie',
      scope: 'ai.invoke',
      active: { orgId: 'org_1', teamId: 'team_1' },
    });
    expect(verified.org).toMatchObject({ org_id: 'org_1', teams: ['team_1', 'team_2'] });
  });

  it('still accepts a legacy email-bearing inbound token', async () => {
    const { now, token } = await signInboundToken();

    const verified = await verifyChainedSubjectAccessToken(
      { subjectToken: token, callerAudience, issuer },
      { now: () => now },
    );

    expect(verified.email).toBe('nessie-user@example.com');
    expect(verified.sub).toBe(userId);
  });

  it('verifies a production-signed no-email nessie-identity token for the exact auth origin', async () => {
    // The token is minted by the real signer with the same env key the
    // verifier resolves through getAccessTokenPublicJwks: this is the exact
    // artifact the first-hop exchange hands to the privileged product —
    // audience is UOA's own auth origin and there is no email claim.
    const authOriginAudience = 'https://authentication.unlikeotherai.com';
    const token = await signConfidentialAccessToken({
      subject: userId,
      credentialEpoch: 0,
      sourceDomain,
      product: 'nessie-identity',
      resource: authOriginAudience,
      issuer,
      ttlSeconds: 240,
      scope: 'identity.read membership.invite membership.manage',
      org: defaultOrg(),
      active: { orgId: 'org_1', teamId: 'team_1' },
    });
    expect(decodeJwt(token)).not.toHaveProperty('email');

    const now = Math.floor(Date.now() / 1000);
    const verified = await verifyChainedSubjectAccessToken(
      { subjectToken: token, callerAudience: authOriginAudience, issuer },
      { now: () => now },
    );

    expect(verified.email).toBeUndefined();
    expect(verified).toMatchObject({
      iss: issuer,
      aud: authOriginAudience,
      sub: userId,
      tv: 0,
      source_domain: sourceDomain,
      azp: sourceDomain,
      product: 'nessie-identity',
      scope: 'identity.read membership.invite membership.manage',
      active: { orgId: 'org_1', teamId: 'team_1' },
    });

    // The same token is rejected for any other audience — the exact
    // auth-origin audience binding is what makes the privileged token
    // unusable as a downstream product's resource token.
    await expect(
      verifyChainedSubjectAccessToken(
        { subjectToken: token, callerAudience, issuer },
        { now: () => now },
      ),
    ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
  });
});
