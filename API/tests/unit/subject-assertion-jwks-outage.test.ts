import Fastify from 'fastify';
import { lookup } from 'node:dns/promises';
import type { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { resolveOrgUserClaims } from '../../src/middleware/org-role-guard.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { verifyConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';
import { PartnerJwksUnavailableError } from '../../src/services/jwks-fetch.service.js';
import { issueSalesResearchJobGrant, SALES_RESEARCH_JOB_GRANT_AUDIENCE_PATH }
  from '../../src/services/sales-research-job-grant.service.js';
import { buildPublicErrorBody } from '../../src/utils/error-response.js';

const sourceDomain = 'client.example.com';
const audience = 'https://authentication.unlikeotherai.com/org';
let privateKey: KeyLike;
let publicJwk: JWK;
let configJwt: string;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...await exportJWK(pair.publicKey), kid: 'source-key', alg: 'RS256', use: 'sig' };
  configJwt = await new SignJWT({ domain: sourceDomain,
    jwks_url: `https://${sourceDomain}/.well-known/jwks.json` })
    .setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const assertion = async (key = privateKey, expires = 60, target = audience): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ source_domain: sourceDomain, tv: 0, active: { orgId: 'org_1', teamId: 'team_1' } })
    .setProtectedHeader({ alg: 'RS256', kid: 'source-key' }).setIssuer(sourceDomain)
    .setAudience(target).setSubject('user_1').setJti('request-assertion').setIssuedAt(now)
    .setExpirationTime(now + expires).sign(key);
};

const verify = (subjectToken: string) => verifyConfidentialSubjectToken({
  subjectToken, configJwt, sourceDomain, audience,
});
const keysResponse = () => Response.json({ keys: [publicJwk] });

describe('subject assertion verification during partner JWKS outages', () => {
  it.each([408, 429, 500, 503])('keeps HTTP %s retryable and verifies freshly after recovery', async (status) => {
    vi.stubEnv('DEBUG_ENABLED', 'false');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status }))
      .mockImplementationOnce(keysResponse);
    vi.stubGlobal('fetch', fetchMock);
    const token = await assertion();
    const error = await verify(token).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PartnerJwksUnavailableError);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', statusCode: 503 });
    expect(buildPublicErrorBody({ error, statusCode: 503 }))
      .toEqual({ error: 'Request failed', code: 'INTEGRATION_JWKS_UNAVAILABLE' });
    await expect(verify(token)).resolves.toMatchObject({ sub: 'user_1', tv: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([new DOMException('timed out', 'AbortError'), new TypeError('socket reset')])(
    'preserves transport failure as unavailable without a negative authority cache: %s', async (failure) => {
      const fetchMock = vi.fn().mockRejectedValueOnce(failure).mockImplementationOnce(keysResponse);
      vi.stubGlobal('fetch', fetchMock);
      const token = await assertion();
      await expect(verify(token)).rejects.toBeInstanceOf(PartnerJwksUnavailableError);
      await expect(verify(token)).resolves.toMatchObject({ sub: 'user_1' });
    },
  );

  it('keeps transient DNS retryable before fetch and verifies freshly after resolver recovery', async () => {
    vi.mocked(lookup).mockRejectedValueOnce(Object.assign(new Error('temporary resolver failure'), { code: 'EAI_AGAIN' }));
    const fetchMock = vi.fn().mockImplementation(keysResponse);
    vi.stubGlobal('fetch', fetchMock);
    const token = await assertion();
    await expect(verify(token)).rejects.toMatchObject({ statusCode: 503, message: 'INTEGRATION_JWKS_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(verify(token)).resolves.toMatchObject({ sub: 'user_1', tv: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['ENOTFOUND', 'private_ip'])('retains a definitive unsafe destination refusal: %s', async (failure) => {
    if (failure === 'private_ip') vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    else vi.mocked(lookup).mockRejectedValueOnce(Object.assign(new Error('not found'), { code: failure }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(verify(await assertion())).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_SUBJECT_TOKEN' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains real invalid-signature, expiry, audience and missing-key refusals', async () => {
    const wrongPair = await generateKeyPair('RS256');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(keysResponse));
    for (const token of [await assertion(wrongPair.privateKey), await assertion(privateKey, -30),
      await assertion(privateKey, 60, 'https://other.example.com/org')]) {
      await expect(verify(token)).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_SUBJECT_TOKEN' });
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ keys: [{ ...publicJwk, kid: 'other-key' }] })));
    await expect(verify(await assertion())).rejects.toMatchObject({ statusCode: 401, message: 'INVALID_SUBJECT_TOKEN' });
  });

  it('does not issue a research-job grant or touch identity after a key outage', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://authentication.unlikeotherai.com');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const databaseAccess = vi.fn(() => { throw new Error('no grant or identity work during outage'); });
    const prisma = { $transaction: databaseAccess, user: { findUnique: databaseAccess } } as unknown as PrismaClient;
    await expect(issueSalesResearchJobGrant({ clientDomainId: 'client_1', sourceDomain, configJwt, config: {},
      requestId: '00000000-0000-4000-8000-000000000001', subjectToken: await assertion(privateKey, 60,
        `https://authentication.unlikeotherai.com${SALES_RESEARCH_JOB_GRANT_AUDIENCE_PATH}`),
    }, { prisma })).rejects.toBeInstanceOf(PartnerJwksUnavailableError);
    expect(databaseAccess).not.toHaveBeenCalled();
  });

  it.each(['http', 'dns'])('returns the generic production 503 through the actual org guard: %s', async (failure) => {
    vi.stubEnv('DEBUG_ENABLED', 'false');
    if (failure === 'dns') {
      vi.mocked(lookup).mockRejectedValueOnce(Object.assign(new Error('temporary resolver failure'), { code: 'EAI_AGAIN' }));
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const token = await assertion();
    const localRead = vi.fn(() => { throw new Error('no identity or membership read before signature verification'); });
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/org/me', async (request) => {
      request.config = { domain: sourceDomain, org_features: { enabled: true } } as ClientConfig;
      request.configJwt = configJwt;
      request.adminDb = { user: { findUnique: localRead } } as unknown as typeof request.adminDb;
      return resolveOrgUserClaims(request);
    });
    try {
      const response = await app.inject({ url: `/org/me?domain=${sourceDomain}`,
        headers: { 'x-uoa-subject-assertion': token } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'Request failed', code: 'INTEGRATION_JWKS_UNAVAILABLE' });
      expect(localRead).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
