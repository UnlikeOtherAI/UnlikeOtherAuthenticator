import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

import { signLoginSession, verifyLoginSession } from '../../src/services/login-session.service.js';

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

const SECRET = 'test-shared-secret-with-enough-length';
const AUDIENCE = 'uoa:login-session';

describe('login-session.service', () => {
  it('round-trips a signed login_token', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({
      userId: 'user-1',
      domain: 'client.example.com',
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
      ttlMs: 10 * 60 * 1000,
    });

    const session = await verifyLoginSession({
      token,
      domain: 'client.example.com',
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });

    expect(session).toEqual({ userId: 'user-1', domain: 'client.example.com' });
  });

  it('rejects a domain mismatch', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({
      userId: 'user-1',
      domain: 'client.example.com',
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });

    await expect(
      verifyLoginSession({
        token,
        domain: 'other.example.com',
        sharedSecret: SECRET,
        audience: AUDIENCE,
        now,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects an expired token', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({
      userId: 'user-1',
      domain: 'client.example.com',
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
      ttlMs: 1000,
    });

    await expect(
      verifyLoginSession({
        token,
        domain: 'client.example.com',
        sharedSecret: SECRET,
        audience: AUDIENCE,
        now: new Date(now.getTime() + 5000),
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects the wrong audience', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({
      userId: 'user-1',
      domain: 'client.example.com',
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });

    await expect(
      verifyLoginSession({
        token,
        domain: 'client.example.com',
        sharedSecret: SECRET,
        audience: 'uoa:access-token',
        now,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a token minted for a different purpose (e.g. a 2FA challenge shape)', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const foreignToken = await new SignJWT({
      domain: 'client.example.com',
      typ: 'twofa_challenge',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('uoa:login-session')
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor((now.getTime() + 60_000) / 1000))
      .sign(secretKey(SECRET));

    await expect(
      verifyLoginSession({
        token: foreignToken,
        domain: 'client.example.com',
        sharedSecret: SECRET,
        audience: AUDIENCE,
        now,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a token issued with the wrong issuer (e.g. a real twofa_token)', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const foreignToken = await new SignJWT({
      domain: 'client.example.com',
      typ: 'login_session',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('uoa:twofa-challenge')
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor((now.getTime() + 60_000) / 1000))
      .sign(secretKey(SECRET));

    await expect(
      verifyLoginSession({
        token: foreignToken,
        domain: 'client.example.com',
        sharedSecret: SECRET,
        audience: AUDIENCE,
        now,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
