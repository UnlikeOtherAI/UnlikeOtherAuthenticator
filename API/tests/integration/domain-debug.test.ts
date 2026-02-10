import { afterEach, describe, expect, it } from 'vitest';

import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { createClientId } from '../../src/utils/hash.js';

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

async function signTestAccessToken(params: {
  userId: string;
  email: string;
  domain: string;
  role: 'superuser' | 'user';
  sharedSecret: string;
  issuer: string;
}): Promise<string> {
  const clientId = createClientId(params.domain, params.sharedSecret);

  return await new SignJWT({
    email: params.email,
    domain: params.domain,
    client_id: clientId,
    role: params.role,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(params.issuer)
    .setSubject(params.userId)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(sharedSecretKey(params.sharedSecret));
}

describe('GET /domain/debug', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIssuer = process.env.AUTH_SERVICE_IDENTIFIER;

  afterEach(() => {
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalIssuer;
  });

  it('returns debug info when authorized with domain hash and superuser access token', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    const domain = 'client.example.com';
    const domainHash = createClientId(domain, process.env.SHARED_SECRET);
    const accessToken = await signTestAccessToken({
      userId: 'user_1',
      email: 'admin@example.com',
      domain,
      role: 'superuser',
      sharedSecret: process.env.SHARED_SECRET,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/domain/debug?domain=${encodeURIComponent(domain)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${accessToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      domain,
      client_id: domainHash,
      superuser: { user_id: 'user_1', email: 'admin@example.com' },
    });

    await app.close();
  });

  it('returns 401 when x-uoa-access-token is missing', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    const domain = 'client.example.com';
    const domainHash = createClientId(domain, process.env.SHARED_SECRET);

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/domain/debug?domain=${encodeURIComponent(domain)}`,
      headers: { authorization: `Bearer ${domainHash}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('returns 403 when access token role is not superuser', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    const domain = 'client.example.com';
    const domainHash = createClientId(domain, process.env.SHARED_SECRET);
    const accessToken = await signTestAccessToken({
      userId: 'user_2',
      email: 'user@example.com',
      domain,
      role: 'user',
      sharedSecret: process.env.SHARED_SECRET,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/domain/debug?domain=${encodeURIComponent(domain)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${accessToken}`,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });

  it('returns 403 when access token domain does not match query domain', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    const domain = 'client.example.com';
    const otherDomain = 'other.example.com';

    const domainHash = createClientId(domain, process.env.SHARED_SECRET);
    const accessToken = await signTestAccessToken({
      userId: 'user_1',
      email: 'admin@example.com',
      domain: otherDomain,
      role: 'superuser',
      sharedSecret: process.env.SHARED_SECRET,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER,
    });

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/domain/debug?domain=${encodeURIComponent(domain)}`,
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${accessToken}`,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});

