import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { verifyConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';

const sourceDomain = 'api.nessie.works';
const audience = 'https://authentication.unlikeotherai.com/auth/token';
const jwksUrl = `https://${sourceDomain}/.well-known/jwks.json`;

let sourcePrivateKey: KeyLike;
let sourcePublicJwk: JWK;
let configJwt: string;

async function signSubjectToken(
  overrides: {
    audience?: string;
    expiresInSeconds?: number;
    sourceDomain?: string;
    active?: unknown;
    omitActive?: boolean;
    jti?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    source_domain: overrides.sourceDomain ?? sourceDomain,
    tv: 0,
  };
  if (!overrides.omitActive) {
    payload.active = Object.prototype.hasOwnProperty.call(overrides, 'active')
      ? overrides.active
      : { orgId: 'org_1', teamId: 'team_1' };
  }
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: sourcePublicJwk.kid!, typ: 'JWT' })
    .setIssuer(sourceDomain)
    .setAudience(overrides.audience ?? audience)
    .setSubject('usr_1')
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expiresInSeconds ?? 60));
  if (overrides.jti !== '') jwt.setJti(overrides.jti ?? 'assertion_1');
  return await jwt.sign(sourcePrivateKey);
}

function fetchJwks() {
  return vi.fn().mockResolvedValue({ keys: [sourcePublicJwk] });
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  sourcePrivateKey = pair.privateKey;
  sourcePublicJwk = await exportJWK(pair.publicKey);
  sourcePublicJwk.kid = 'nessie-subject-key';
  sourcePublicJwk.alg = 'RS256';
  sourcePublicJwk.use = 'sig';
  configJwt = await new SignJWT({ domain: sourceDomain, jwks_url: jwksUrl })
    .setProtectedHeader({ alg: 'RS256', kid: sourcePublicJwk.kid })
    .sign(sourcePrivateKey);
});

describe('confidential subject-token verification', () => {
  it('verifies the assertion with the JWKS published by the source config', async () => {
    const fetcher = fetchJwks();
    const token = await signSubjectToken();

    const assertion = await verifyConfidentialSubjectToken(
      {
        subjectToken: token,
        configJwt,
        sourceDomain,
        audience,
      },
      { fetchJwks: fetcher },
    );

    expect(assertion.sub).toBe('usr_1');
    expect(assertion.tv).toBe(0);
    expect(assertion.active).toEqual({ orgId: 'org_1', teamId: 'team_1' });
    expect(fetcher).toHaveBeenCalledWith(jwksUrl, {
      expectedHost: sourceDomain,
    });
  });

  it('accepts a signed identity assertion without workspace context', async () => {
    const assertion = await verifyConfidentialSubjectToken(
      {
        subjectToken: await signSubjectToken({ omitActive: true }),
        configJwt,
        sourceDomain,
        audience,
      },
      { fetchJwks: fetchJwks() },
    );

    expect(assertion.sub).toBe('usr_1');
    expect(assertion).not.toHaveProperty('active');
  });

  it('rejects partial or malformed workspace context', async () => {
    const malformedActiveClaims: unknown[] = [
      {},
      { orgId: 'org_1' },
      { teamId: 'team_1' },
      { orgId: '', teamId: 'team_1' },
      { orgId: 'org_1', teamId: '' },
      { orgId: 'org_1', teamId: 'team_1', extra: true },
      null,
    ];

    for (const active of malformedActiveClaims) {
      await expect(
        verifyConfidentialSubjectToken(
          {
            subjectToken: await signSubjectToken({ active }),
            configJwt,
            sourceDomain,
            audience,
          },
          { fetchJwks: fetchJwks() },
        ),
      ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    }
  });

  it('rejects a subject assertion whose lifetime exceeds 60 seconds', async () => {
    const token = await signSubjectToken({ expiresInSeconds: 61 });
    await expect(
      verifyConfidentialSubjectToken(
        { subjectToken: token, configJwt, sourceDomain, audience },
        { fetchJwks: fetchJwks() },
      ),
    ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
  });

  it('rejects the wrong source domain, audience, or a missing jti', async () => {
    const wrongSource = await signSubjectToken({ sourceDomain: 'evil.example.com' });
    const wrongAudience = await signSubjectToken({
      audience: 'https://authentication.unlikeotherai.com/oauth/token',
    });
    const noJti = await signSubjectToken({ jti: '' });

    for (const subjectToken of [wrongSource, wrongAudience, noJti]) {
      await expect(
        verifyConfidentialSubjectToken(
          { subjectToken, configJwt, sourceDomain, audience },
          { fetchJwks: fetchJwks() },
        ),
      ).rejects.toThrow('INVALID_SUBJECT_TOKEN');
    }
  });
});
