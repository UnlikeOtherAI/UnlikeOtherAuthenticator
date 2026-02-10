import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createHmac } from 'node:crypto';

import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/services/password.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function createSignedConfigJwt(
  sharedSecret: string,
  overrides?: Record<string, unknown>,
): Promise<string> {
  const aud = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  return await new SignJWT(baseClientConfigPayload(overrides))
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(aud)
    .sign(new TextEncoder().encode(sharedSecret));
}

function base32Decode(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = value.replace(/=+$/g, '').toUpperCase().replace(/[^A-Z2-7]/g, '');

  let bits = 0;
  let buffer = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    buffer = (buffer << 5) | idx;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function computeTotp(params: { secret: string; nowMs: number; digits?: 6 | 8; period?: number }): string {
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;

  const counter = BigInt(Math.floor(params.nowMs / 1000 / period));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);

  const mac = createHmac('sha1', Buffer.from(base32Decode(params.secret))).update(counterBuf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binCode =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  const mod = digits === 8 ? 100_000_000 : 1_000_000;
  const otp = binCode % mod;
  return String(otp).padStart(digits, '0');
}

describe.skipIf(!hasDatabase)('POST /auth/login', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSharedSecret = process.env.SHARED_SECRET;
  const originalAud = process.env.AUTH_SERVICE_IDENTIFIER;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.SHARED_SECRET = originalSharedSecret;
    process.env.AUTH_SERVICE_IDENTIFIER = originalAud;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.authorizationCode.deleteMany();
    await handle.prisma.verificationToken.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns 200 on correct credentials', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const passwordHash = await hashPassword('Abcdef1!');
    const created = await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        passwordHash,
      },
      select: { id: true },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=${encodeURIComponent(configUrl)}`,
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; code: string; redirect_to: string };
    expect(body.ok).toBe(true);
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThan(10);

    const u = new URL(body.redirect_to);
    expect(`${u.origin}${u.pathname}`).toBe('https://client.example.com/oauth/callback');
    expect(u.searchParams.get('code')).toBe(body.code);

    const codes = await handle!.prisma.authorizationCode.findMany({
      where: { userId: created.id },
      select: { domain: true, configUrl: true, redirectUrl: true, usedAt: true },
    });
    expect(codes).toHaveLength(1);
    expect(codes[0].domain).toBe('client.example.com');
    expect(codes[0].configUrl).toBe(configUrl);
    expect(codes[0].redirectUrl).toBe('https://client.example.com/oauth/callback');
    expect(codes[0].usedAt).toBeNull();

    await app.close();
  });

  it('requires 2FA when enabled in config and on the user record', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-10T00:00:00.000Z'));

    let app: Awaited<ReturnType<typeof createApp>> | null = null;
    try {
      process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
      process.env.AUTH_SERVICE_IDENTIFIER =
        process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

      const totpSecret = 'JBSWY3DPEHPK3PXP';
      const encrypted = encryptTwoFaSecret({
        secret: totpSecret,
        sharedSecret: process.env.SHARED_SECRET,
      });

      const passwordHash = await hashPassword('Abcdef1!');
      const created = await handle!.prisma.user.create({
        data: {
          email: 'user@example.com',
          userKey: 'user@example.com',
          passwordHash,
          twoFaEnabled: true,
          twoFaSecret: encrypted,
        },
        select: { id: true },
      });

      const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET, { '2fa_enabled': true });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

      app = await createApp();
      await app.ready();

      const configUrl = 'https://client.example.com/auth-config';
      const loginRes = await app.inject({
        method: 'POST',
        url: `/auth/login?config_url=${encodeURIComponent(configUrl)}`,
        payload: { email: 'user@example.com', password: 'Abcdef1!' },
      });

      expect(loginRes.statusCode).toBe(200);
      const loginBody = loginRes.json() as {
        ok: boolean;
        twofa_required?: boolean;
        twofa_token?: string;
      };
      expect(loginBody.ok).toBe(true);
      expect(loginBody.twofa_required).toBe(true);
      expect(typeof loginBody.twofa_token).toBe('string');

      const code = computeTotp({ secret: totpSecret, nowMs: Date.now() });
      const verifyRes = await app.inject({
        method: 'POST',
        url: `/2fa/verify?config_url=${encodeURIComponent(configUrl)}`,
        payload: { twofa_token: loginBody.twofa_token, code },
      });

      expect(verifyRes.statusCode).toBe(200);
      const verifyBody = verifyRes.json() as { ok: boolean; code: string; redirect_to: string };
      expect(verifyBody.ok).toBe(true);

      const u = new URL(verifyBody.redirect_to);
      expect(`${u.origin}${u.pathname}`).toBe('https://client.example.com/oauth/callback');
      expect(u.searchParams.get('code')).toBe(verifyBody.code);

      const codes = await handle!.prisma.authorizationCode.findMany({
        where: { userId: created.id },
        select: { domain: true, configUrl: true, redirectUrl: true, usedAt: true },
      });
      expect(codes).toHaveLength(1);
      expect(codes[0].domain).toBe('client.example.com');
      expect(codes[0].configUrl).toBe(configUrl);
      expect(codes[0].redirectUrl).toBe('https://client.example.com/oauth/callback');
      expect(codes[0].usedAt).toBeNull();
    } finally {
      if (app) await app.close();
      vi.useRealTimers();
    }
  });

  it('returns generic 401 for wrong password and unknown email (no enumeration)', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const passwordHash = await hashPassword('Abcdef1!');
    await handle!.prisma.user.create({
      data: {
        email: 'user@example.com',
        userKey: 'user@example.com',
        passwordHash,
      },
    });

    const jwt = await createSignedConfigJwt(process.env.SHARED_SECRET);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(jwt, { status: 200 })));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const baseUrl = `/auth/login?config_url=${encodeURIComponent(configUrl)}`;

    const wrongPassword = await app.inject({
      method: 'POST',
      url: baseUrl,
      payload: { email: 'user@example.com', password: 'Wrongpass1!' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: baseUrl,
      payload: { email: 'missing@example.com', password: 'Abcdef1!' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);

    expect(wrongPassword.json()).toEqual({ error: 'Request failed' });
    expect(unknownEmail.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});
