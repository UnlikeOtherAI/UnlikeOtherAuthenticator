import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK, type KeyLike } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';
import {
  getUserAccessTokenPublicJwks,
  resetUserAccessTokenKeyCache,
  signUserAccessTokenRs256,
} from '../../src/services/user-access-token-key.service.js';

const SECRET = 'test-shared-secret-with-enough-length';
const ISSUER = 'uoa-auth-service';

const envNames = ['USER_ACCESS_TOKEN_PRIVATE_JWK', 'USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON'] as const;
const originalEnv = Object.fromEntries(envNames.map((n) => [n, process.env[n]])) as Record<
  (typeof envNames)[number],
  string | undefined
>;

let privateJwk: JWK;
let publicJwk: JWK;
let attackerPrivateKey: KeyLike;

const claims = {
  email: 'user@client.example.com',
  domain: 'client.example.com',
  client_id: 'client-1',
  role: 'user' as const,
  tv: 3,
};

function enableRs256(): void {
  process.env.USER_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify(privateJwk);
  process.env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON = JSON.stringify({ keys: [publicJwk] });
  resetUserAccessTokenKeyCache();
}

function disableRs256(): void {
  for (const name of envNames) Reflect.deleteProperty(process.env, name);
  resetUserAccessTokenKeyCache();
}

/** The DB-less branch: `tv` present means signature + epoch claim are authoritative. */
function verify(token: string) {
  return verifyAccessToken(token, { sharedSecret: SECRET, issuer: ISSUER, prisma: undefined });
}

async function hs256Token(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(SECRET));
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateJwk = await exportJWK(pair.privateKey);
  publicJwk = await exportJWK(pair.publicKey);
  Object.assign(privateJwk, { kid: 'user-access-1', alg: 'RS256', use: 'sig' });
  Object.assign(publicJwk, { kid: 'user-access-1', alg: 'RS256', use: 'sig' });
  attackerPrivateKey = (await generateKeyPair('RS256', { extractable: true })).privateKey;
});

afterEach(() => {
  disableRs256();
});

afterAll(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  resetUserAccessTokenKeyCache();
});

describe('user access token — HS256 remains valid throughout', () => {
  it('verifies an HS256 token when RS256 is not configured', async () => {
    const result = await verify(await hs256Token());
    expect(result).toMatchObject({ userId: 'user-1', tokenVersion: 3, role: 'user' });
  });

  it('still verifies already-issued HS256 tokens after RS256 is switched on', async () => {
    const token = await hs256Token();
    enableRs256();
    const result = await verify(token);
    expect(result).toMatchObject({ userId: 'user-1', tokenVersion: 3 });
  });
});

describe('user access token — RS256 is verifiable against the published key', () => {
  it('issues and verifies an RS256 token with the same claims and a kid header', async () => {
    enableRs256();
    const token = await signUserAccessTokenRs256({
      payload: { ...claims },
      issuer: ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      subject: 'user-1',
      ttl: '30m',
    });

    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header).toMatchObject({ alg: 'RS256', kid: 'user-access-1', typ: 'JWT' });

    const result = await verify(token);
    expect(result).toMatchObject({ userId: 'user-1', tokenVersion: 3, role: 'user' });
  });

  it('publishes exactly the verification key a relying party needs, private half absent', async () => {
    enableRs256();
    const jwks = await getUserAccessTokenPublicJwks();
    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key).toMatchObject({ kty: 'RSA', kid: 'user-access-1', alg: 'RS256', use: 'sig' });
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(
        key,
        `published key must not carry the private component ${secret}`,
      ).not.toHaveProperty(secret);
    }
  });

  it('lets a relying party verify with only the published key', async () => {
    enableRs256();
    const token = await signUserAccessTokenRs256({
      payload: { ...claims },
      issuer: ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      subject: 'user-1',
      ttl: '30m',
    });
    const { keys } = await getUserAccessTokenPublicJwks();
    const key = await importJWK(keys[0], 'RS256');
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer: ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    });
    expect(payload.sub).toBe('user-1');
  });
});

describe('user access token — accepting two algorithms is not a downgrade', () => {
  it('refuses an RS256 token signed by a key that is not published', async () => {
    enableRs256();
    const forged = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'user-access-1', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(attackerPrivateKey);

    await expect(verify(forged)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('refuses an RS256 token when the deployment publishes no key', async () => {
    enableRs256();
    const token = await signUserAccessTokenRs256({
      payload: { ...claims },
      issuer: ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      subject: 'user-1',
      ttl: '30m',
    });
    disableRs256();
    await expect(verify(token)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('refuses the classic confusion: public key material used as an HMAC secret', async () => {
    enableRs256();
    // An attacker who has the published key tries to sign HS256 with it, hoping
    // the verifier picks its key by kid rather than by algorithm.
    const publicKeyAsSecret = new TextEncoder().encode(JSON.stringify(publicJwk));
    const forged = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256', kid: 'user-access-1', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(publicKeyAsSecret);

    await expect(verify(forged)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('refuses an unsigned token', async () => {
    enableRs256();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        ...claims,
        sub: 'user-1',
        iss: ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');

    await expect(verify(`${header}.${body}.`)).rejects.toMatchObject({
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('keeps enforcing issuer, audience and the credential epoch on the RS256 path', async () => {
    enableRs256();
    const wrongAudience = await signUserAccessTokenRs256({
      payload: { ...claims },
      issuer: ISSUER,
      audience: 'uoa:something-else',
      subject: 'user-1',
      ttl: '30m',
    });
    await expect(verify(wrongAudience)).rejects.toMatchObject({ statusCode: 401 });

    const wrongIssuer = await signUserAccessTokenRs256({
      payload: { ...claims },
      issuer: 'https://attacker.example.com',
      audience: ACCESS_TOKEN_AUDIENCE,
      subject: 'user-1',
      ttl: '30m',
    });
    await expect(verify(wrongIssuer)).rejects.toMatchObject({ statusCode: 401 });

    const noEpoch = await signUserAccessTokenRs256({
      payload: { ...claims, tv: undefined },
      issuer: ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      subject: 'user-1',
      ttl: '30m',
    });
    await expect(verify(noEpoch)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('user access token — key publication', () => {
  it('serves the user key at /oauth/jwks.json even with no resource-token key', async () => {
    enableRs256();
    Reflect.deleteProperty(process.env, 'MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK');
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/oauth/jwks.json' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { keys: JWK[] };
      expect(body.keys.map((k) => k.kid)).toContain('user-access-1');
      expect(body.keys.every((k) => !('d' in k))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('still 404s when the deployment publishes no signing key at all', async () => {
    disableRs256();
    Reflect.deleteProperty(process.env, 'MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK');
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/oauth/jwks.json' });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
