import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SignJWT } from 'jose';

import { createApp } from '../../src/app.js';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { createClientId } from '../../src/utils/hash.js';
import { cleanClientDomains, seedDomainSecret } from '../helpers/domain-secret.js';
import { expectJsonError } from '../helpers/error-response.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

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
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(params.userId)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(sharedSecretKey(params.sharedSecret));
}

describe.skipIf(!hasDatabase)('GET /domain/debug', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalIssuer = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await cleanClientDomains(handle.prisma);
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalIssuer;
  });

  // Access tokens are re-resolved against the DB: the subject must be a real
  // user row whose tokenVersion matches the token's epoch (fresh users are 0).
  async function seedUser(email: string): Promise<string> {
    const user = await handle!.prisma.user.create({
      data: { email, userKey: email },
      select: { id: true },
    });
    return user.id;
  }

  it('returns debug info when authorized with domain hash and superuser access token', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    const domain = 'client.example.com';
    const domainHash = await seedDomainSecret(handle!.prisma, domain, process.env.SHARED_SECRET);
    // The response names the client-domain ROW, never the bearer the caller
    // presented — see the declaration in domain-hash-auth.ts.
    const clientDomain = await handle!.prisma.clientDomain.findFirstOrThrow({
      where: { domain },
      select: { id: true },
    });
    const userId = await seedUser('admin@example.com');
    const accessToken = await signTestAccessToken({
      userId,
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
    expect(clientDomain.id).not.toBe(domainHash);
    expect(res.json()).toEqual({
      ok: true,
      domain,
      client_id: clientDomain.id,
      superuser: {
        user_id: userId,
        email: 'admin@example.com',
        // Docs/Auth/avatars.md §9 — relative form, PUBLIC_BASE_URL is unset in tests.
        avatar_image_url: `/domain/users/${encodeURIComponent(userId)}/avatar?domain=${encodeURIComponent(domain)}`,
      },
    });

    await app.close();
  });

  it('returns 401 when x-uoa-access-token is missing', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    const domain = 'client.example.com';
    const domainHash = await seedDomainSecret(handle!.prisma, domain, process.env.SHARED_SECRET);

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/domain/debug?domain=${encodeURIComponent(domain)}`,
      headers: { authorization: `Bearer ${domainHash}` },
    });

    expect(res.statusCode).toBe(401);
    expectJsonError(res.json());

    await app.close();
  });

  it('returns 403 when access token role is not superuser', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    const domain = 'client.example.com';
    const domainHash = await seedDomainSecret(handle!.prisma, domain, process.env.SHARED_SECRET);
    const userId = await seedUser('user@example.com');
    const accessToken = await signTestAccessToken({
      userId,
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
    expectJsonError(res.json());

    await app.close();
  });

  it('returns 403 when access token domain does not match query domain', async () => {
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';

    const domain = 'client.example.com';
    const otherDomain = 'other.example.com';

    const domainHash = await seedDomainSecret(handle!.prisma, domain, process.env.SHARED_SECRET);
    const userId = await seedUser('admin@example.com');
    const accessToken = await signTestAccessToken({
      userId,
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
    expectJsonError(res.json());

    await app.close();
  });
});
