import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { verifyAccessToken } from '../../src/services/access-token.service.js';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

// Stub the user lookup verifyAccessToken performs for token-version revocation.
// `tokenVersion: null` simulates a missing user.
function depsWithTokenVersion(tokenVersion: number | null) {
  return {
    prisma: {
      user: {
        findUnique: async () => (tokenVersion === null ? null : { tokenVersion }),
      },
    },
  } as unknown as Parameters<typeof verifyAccessToken>[1];
}

async function signAccessToken(params: {
  sharedSecret: string;
  issuer: string;
  subject?: string;
  audience?: string | null;
  alg?: 'HS256' | 'HS512';
  ttl?: string;
  tv?: number;
  org?: {
    org_id: string;
    org_role: string;
    teams: string[];
    team_roles: Record<string, string>;
    groups?: string[];
    group_admin?: string[];
  };
  active?: {
    orgId: string;
    teamId: string;
  };
}): Promise<string> {
  const alg = params.alg ?? 'HS256';
  const ttl = params.ttl ?? '30m';
  const org = params.org;
  const active = params.active;

  const jwt = new SignJWT({
    email: 'user@example.com',
    domain: 'client.example.com',
    client_id: 'client-id',
    role: 'superuser',
    tv: params.tv ?? 0,
    ...(org ? { org } : {}),
    ...(active ? { active } : {}),
  })
    .setProtectedHeader({ alg, typ: 'JWT' })
    .setIssuer(params.issuer)
    .setIssuedAt()
    .setExpirationTime(ttl);

  if (params.audience !== null) jwt.setAudience(params.audience ?? ACCESS_TOKEN_AUDIENCE);
  if (params.subject != null) jwt.setSubject(params.subject);

  return await jwt.sign(secretKey(params.sharedSecret));
}

describe('verifyAccessToken', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIssuer = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalIssuer;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('accepts a valid JWT without org claim and returns claims', async () => {
    const token = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
    });

    const claims = await verifyAccessToken(token, depsWithTokenVersion(0));
    expect(claims).toEqual({
      userId: 'u1',
      email: 'user@example.com',
      domain: 'client.example.com',
      clientId: 'client-id',
      role: 'superuser',
    });
  });

  it('accepts a valid JWT with org claim and returns claims including org', async () => {
    const token = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u2',
      org: {
        org_id: 'org_1',
        org_role: 'member',
        teams: ['team_a', 'team_b'],
        team_roles: { team_a: 'lead', team_b: 'member' },
      },
    });

    const claims = await verifyAccessToken(token, depsWithTokenVersion(0));
    expect(claims).toEqual({
      userId: 'u2',
      email: 'user@example.com',
      domain: 'client.example.com',
      clientId: 'client-id',
      role: 'superuser',
      org: {
        org_id: 'org_1',
        org_role: 'member',
        teams: ['team_a', 'team_b'],
        team_roles: { team_a: 'lead', team_b: 'member' },
      },
    });
  });

  it('accepts a valid JWT with an active workspace claim', async () => {
    const token = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u3',
      active: { orgId: 'org_1', teamId: 'team_a' },
    });

    const claims = await verifyAccessToken(token, depsWithTokenVersion(0));
    expect(claims).toEqual({
      userId: 'u3',
      email: 'user@example.com',
      domain: 'client.example.com',
      clientId: 'client-id',
      role: 'superuser',
      active: { orgId: 'org_1', teamId: 'team_a' },
    });
  });

  it('rejects expired tokens (short-lived enforcement via exp)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-10T00:00:00.000Z'));

    const token = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
      ttl: '1s',
    });

    // The verifier allows a 30s clockTolerance for parity with config.service.ts;
    // push past that window so the token is unambiguously expired.
    vi.setSystemTime(new Date('2026-02-10T00:01:00.000Z'));

    await expect(verifyAccessToken(token, depsWithTokenVersion(0))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects tokens with wrong issuer or algorithm', async () => {
    const wrongIssuerToken = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: 'someone-else',
      subject: 'u1',
    });
    await expect(
      verifyAccessToken(wrongIssuerToken, depsWithTokenVersion(0)),
    ).rejects.toMatchObject({ statusCode: 401 });

    const wrongAlgToken = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
      alg: 'HS512',
    });
    await expect(verifyAccessToken(wrongAlgToken, depsWithTokenVersion(0))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects tokens with missing or wrong audience', async () => {
    const missingAudienceToken = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
      audience: null,
    });
    await expect(
      verifyAccessToken(missingAudienceToken, depsWithTokenVersion(0)),
    ).rejects.toMatchObject({ statusCode: 401 });

    const wrongAudienceToken = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
      audience: 'someone-else',
    });
    await expect(
      verifyAccessToken(wrongAudienceToken, depsWithTokenVersion(0)),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a token whose tv no longer matches the user (logout/reset revokes access)', async () => {
    const token = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
      tv: 0,
    });

    // Token verifies fine while versions match.
    await expect(verifyAccessToken(token, depsWithTokenVersion(0))).resolves.toMatchObject({
      userId: 'u1',
    });

    // After a logout/reset bumps the user's tokenVersion to 1, the same token
    // (still tv:0, still unexpired, still validly signed) must be rejected.
    await expect(verifyAccessToken(token, depsWithTokenVersion(1))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects a token when the user no longer exists', async () => {
    const token = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
      tv: 0,
    });

    await expect(verifyAccessToken(token, depsWithTokenVersion(null))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects a token with no tv claim', async () => {
    const jwt = new SignJWT({
      email: 'user@example.com',
      domain: 'client.example.com',
      client_id: 'client-id',
      role: 'superuser',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(process.env.AUTH_SERVICE_IDENTIFIER!)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setSubject('u1')
      .setIssuedAt()
      .setExpirationTime('30m');
    const token = await jwt.sign(secretKey(process.env.SHARED_SECRET!));

    await expect(verifyAccessToken(token, depsWithTokenVersion(0))).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
