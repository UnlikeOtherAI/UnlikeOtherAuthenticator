import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';

import { verifyAccessToken } from '../../src/services/access-token.service.js';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function signAccessToken(params: {
  sharedSecret: string;
  issuer: string;
  subject?: string;
  alg?: 'HS256' | 'HS512';
  ttl?: string;
}): Promise<string> {
  const alg = params.alg ?? 'HS256';
  const ttl = params.ttl ?? '30m';

  const jwt = new SignJWT({
    email: 'user@example.com',
    domain: 'client.example.com',
    client_id: 'client-id',
    role: 'superuser',
  })
    .setProtectedHeader({ alg, typ: 'JWT' })
    .setIssuer(params.issuer)
    .setIssuedAt()
    .setExpirationTime(ttl);

  if (params.subject != null) jwt.setSubject(params.subject);

  return await jwt.sign(secretKey(params.sharedSecret));
}

describe('verifyAccessToken', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIssuer = process.env.AUTH_SERVICE_IDENTIFIER;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalIssuer;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('accepts a valid, self-contained JWT and returns claims (stateless verification)', async () => {
    const token = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
    });

    const claims = await verifyAccessToken(token);
    expect(claims).toEqual({
      userId: 'u1',
      email: 'user@example.com',
      domain: 'client.example.com',
      clientId: 'client-id',
      role: 'superuser',
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

    vi.setSystemTime(new Date('2026-02-10T00:00:02.000Z'));

    await expect(verifyAccessToken(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects tokens with wrong issuer or algorithm', async () => {
    const wrongIssuerToken = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: 'someone-else',
      subject: 'u1',
    });
    await expect(verifyAccessToken(wrongIssuerToken)).rejects.toMatchObject({ statusCode: 401 });

    const wrongAlgToken = await signAccessToken({
      sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      subject: 'u1',
      alg: 'HS512',
    });
    await expect(verifyAccessToken(wrongAlgToken)).rejects.toMatchObject({ statusCode: 401 });
  });
});

