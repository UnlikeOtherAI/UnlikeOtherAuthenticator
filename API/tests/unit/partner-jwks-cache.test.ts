import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyConfidentialSubjectToken } from '../../src/services/confidential-token-exchange.service.js';
import { PartnerJwksUnavailableError } from '../../src/services/jwks-fetch.service.js';
import {
  PARTNER_JWKS_REFRESH_COOLDOWN_MS,
  resetPartnerJwksCache,
} from '../../src/services/partner-jwks-cache.service.js';

const sourceDomain = 'client.example.com';
const audience = 'https://authentication.unlikeotherai.com/org';
const KEEP_MS = 60_000;

type Signer = { privateKey: KeyLike; jwk: JWK; kid: string };
let first: Signer;
let rotated: Signer;
let replaced: Signer;
let stranger: Signer;
let configJwt: string;

async function signer(kid: string): Promise<Signer> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  return { privateKey: pair.privateKey, kid,
    jwk: { ...await exportJWK(pair.publicKey), kid, alg: 'RS256', use: 'sig' } };
}

beforeAll(async () => {
  first = await signer('key-a');
  rotated = await signer('key-b');
  // A product that swaps the key but keeps the `kid`.
  replaced = await signer('key-a');
  stranger = await signer('key-a');
  configJwt = await new SignJWT({ domain: sourceDomain,
    jwks_url: `https://${sourceDomain}/.well-known/jwks.json` })
    .setProtectedHeader({ alg: 'RS256' }).sign(first.privateKey);
});

let published: JWK[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('PARTNER_JWKS_CACHE_SECONDS', '60');
  resetPartnerJwksCache();
  published = [first.jwk];
  fetchMock = vi.fn(async () => Response.json({ keys: published }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const assertion = async (by: Signer, target = audience): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ source_domain: sourceDomain, tv: 0, active: { orgId: 'org_1', teamId: 'team_1' } })
    .setProtectedHeader({ alg: 'RS256', kid: by.kid }).setIssuer(sourceDomain)
    .setAudience(target).setSubject('user_1').setJti('kept-keys').setIssuedAt(now)
    .setExpirationTime(now + 60).sign(by.privateKey);
};

const verify = async (by: Signer, target?: string) => verifyConfidentialSubjectToken({
  subjectToken: await assertion(by, target), configJwt, sourceDomain, audience,
});
const pass = (ms: number): void => { vi.setSystemTime(Date.now() + ms); };
const refused = { statusCode: 401, message: 'INVALID_SUBJECT_TOKEN' };

describe('kept partner signing keys', () => {
  it('asks the product once for the assertions of one minute, then again', async () => {
    for (let call = 0; call < 3; call += 1) {
      await expect(verify(first)).resolves.toMatchObject({ sub: 'user_1' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pass(KEEP_MS + 1);
    await expect(verify(first)).resolves.toMatchObject({ sub: 'user_1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one read between assertions that arrive together', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(first)));
    expect(results).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a rotated key on the first token it signs', async () => {
    await verify(first);
    pass(PARTNER_JWKS_REFRESH_COOLDOWN_MS + 1);
    published = [rotated.jwk];

    await expect(verify(rotated)).resolves.toMatchObject({ sub: 'user_1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The key the product removed is refused from then on, without another read.
    await expect(verify(first)).rejects.toMatchObject(refused);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads a key replaced under the same kid once the cooldown has passed', async () => {
    await verify(first);
    published = [replaced.jwk];

    await expect(verify(replaced)).rejects.toMatchObject(refused);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pass(PARTNER_JWKS_REFRESH_COOLDOWN_MS + 1);
    await expect(verify(replaced)).resolves.toMatchObject({ sub: 'user_1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not turn tokens no key verifies into a fetch each', async () => {
    await verify(first);
    pass(PARTNER_JWKS_REFRESH_COOLDOWN_MS + 1);

    await expect(verify(stranger)).rejects.toMatchObject(refused);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (let call = 0; call < 4; call += 1) {
      await expect(verify(stranger)).rejects.toMatchObject(refused);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The product's real key still verifies.
    await expect(verify(first)).resolves.toMatchObject({ sub: 'user_1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never asks again for a token the right key refuses for another reason', async () => {
    await verify(first);
    pass(PARTNER_JWKS_REFRESH_COOLDOWN_MS + 1);

    await expect(verify(first, 'https://authentication.unlikeotherai.com/auth/token'))
      .rejects.toMatchObject(refused);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing from a failed read and never answers from an older copy', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(verify(first)).rejects.toBeInstanceOf(PartnerJwksUnavailableError);
    await expect(verify(first)).resolves.toMatchObject({ sub: 'user_1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    pass(KEEP_MS + 1);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(verify(first)).rejects.toBeInstanceOf(PartnerJwksUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reads for every assertion when keeping is switched off', async () => {
    vi.stubEnv('PARTNER_JWKS_CACHE_SECONDS', '0');
    await verify(first);
    await verify(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
