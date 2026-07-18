import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';

import {
  getAccessTokenPublicJwks,
  resetAccessTokenKeyCache,
  signConfidentialAccessToken,
  signMcpAccessToken,
} from '../access-token.service.js';

// Round-trips an MCP-profile access token: sign with the configured RS256 key, then
// verify it the way a resource server (e.g. hw-api) would — against the published
// public JWKS, checking issuer + resource-bound audience.
describe('mcp access-token (RS256)', () => {
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(privateKey);
    jwk.kid = 'mcp-test-kid';
    jwk.alg = 'RS256';
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(jwk);
    resetAccessTokenKeyCache();
  });

  it('publishes a public JWKS with no private material', async () => {
    const { keys } = await getAccessTokenPublicJwks();
    expect(keys).toHaveLength(1);
    const key = keys[0];
    expect(key?.kid).toBe('mcp-test-kid');
    expect(key?.use).toBe('sig');
    expect(key?.alg).toBe('RS256');
    expect(key?.d).toBeUndefined();
    expect(key?.p).toBeUndefined();
  });

  it('signs a resource-bound token verifiable against the public JWKS', async () => {
    const resource = 'https://hw.kilomayo.dev/api/v1/mcp';
    const token = await signMcpAccessToken({
      subject: 'usr_1',
      email: 'a@b.com',
      domain: 'sso.kilomayo.dev',
      clientId: 'mcp_abc',
      role: 'user',
      resource,
      issuer: 'https://sso.kilomayo.dev',
      ttlSeconds: 1800,
      scope: 'openid',
    });

    const jwks = createLocalJWKSet(await getAccessTokenPublicJwks());
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: 'https://sso.kilomayo.dev',
      audience: resource,
    });
    expect(protectedHeader.alg).toBe('RS256');
    expect(protectedHeader.kid).toBe('mcp-test-kid');
    expect(payload.sub).toBe('usr_1');
    expect(payload.aud).toBe(resource);
    expect(payload.email).toBe('a@b.com');
    expect(payload.role).toBe('user');
    expect(payload.client_id).toBe('mcp_abc');
  });

  it('a token bound to one resource fails audience check for another', async () => {
    const token = await signMcpAccessToken({
      subject: 'usr_1',
      email: 'a@b.com',
      domain: 'sso.kilomayo.dev',
      clientId: 'mcp_abc',
      role: 'user',
      resource: 'https://hw.kilomayo.dev/api/v1/mcp',
      issuer: 'https://sso.kilomayo.dev',
      ttlSeconds: 1800,
    });
    const jwks = createLocalJWKSet(await getAccessTokenPublicJwks());
    await expect(
      jwtVerify(token, jwks, { audience: 'https://other.example/mcp' }),
    ).rejects.toThrow();
  });

  it('signs confidential exchange tokens without copying a domain credential', async () => {
    const resource = 'https://ledger.unlikeotherai.com';
    const token = await signConfidentialAccessToken({
      subject: 'usr_1',
      email: 'a@b.com',
      sourceDomain: 'api.nessie.works',
      resource,
      issuer: 'https://authentication.unlikeotherai.com',
      ttlSeconds: 300,
      scope: 'ai.invoke',
      org: {
        org_id: 'org_1',
        org_role: 'member',
        teams: ['team_1'],
        team_roles: { team_1: 'member' },
      },
      active: { orgId: 'org_1', teamId: 'team_1' },
    });

    const jwks = createLocalJWKSet(await getAccessTokenPublicJwks());
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: 'https://authentication.unlikeotherai.com',
      audience: resource,
    });
    expect(protectedHeader.typ).toBe('at+jwt');
    expect(payload).toMatchObject({
      sub: 'usr_1',
      email: 'a@b.com',
      source_domain: 'api.nessie.works',
      azp: 'api.nessie.works',
      scope: 'ai.invoke',
      active: { orgId: 'org_1', teamId: 'team_1' },
    });
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.client_id).toBeUndefined();
    expect(payload.domain).toBeUndefined();
  });
});
