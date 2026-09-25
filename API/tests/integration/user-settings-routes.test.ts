import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  ACCESS_TOKEN_AUDIENCE,
  USER_SETTINGS_MAX_ENTRIES,
  USER_SETTINGS_MAX_VALUE_BYTES,
} from '../../src/config/constants.js';
import { updateUserSettings } from '../../src/services/user-settings.service.js';
import { createClientId } from '../../src/utils/hash.js';
import { cleanClientDomains, seedDomainSecret } from '../helpers/domain-secret.js';
import { expectJsonError } from '../helpers/error-response.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

const SHARED_SECRET = 'test-shared-secret-with-enough-length';
const ISSUER = 'uoa-auth-service';
const DOMAIN = 'client.example.com';
const OTHER_DOMAIN = 'other.example.com';

const BOOKMARKS = [
  { favicon: 'https://example.com/favicon.ico', url: 'https://example.com/', name: 'Example' },
  { favicon: null, url: 'https://uoa.example.com/docs', name: 'Docs — ünïcode' },
];

async function signAccessToken(params: {
  userId: string;
  email: string;
  domain: string;
}): Promise<string> {
  return await new SignJWT({
    email: params.email,
    domain: params.domain,
    client_id: createClientId(params.domain, SHARED_SECRET),
    role: 'user',
    tv: 0,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.userId)
    .setIssuer(ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(SHARED_SECRET));
}

describe.skipIf(!hasDatabase)('user settings routes', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let app: Awaited<ReturnType<typeof createApp>> | null = null;

  const original = {
    DATABASE_URL: process.env.DATABASE_URL,
    SHARED_SECRET: process.env.SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  };

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET = SHARED_SECRET;
    process.env.AUTH_SERVICE_IDENTIFIER = ISSUER;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.userSetting.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();
    await cleanClientDomains(handle.prisma);

    app = await createApp();
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function seedCaller(email: string, domain = DOMAIN) {
    const user = await handle!.prisma.user.create({
      data: { email, userKey: `${domain}|${email}`, passwordHash: null, name: 'Test User' },
      select: { id: true },
    });
    await handle!.prisma.domainRole.create({
      data: { domain, userId: user.id, role: 'USER' },
    });
    const token = await signAccessToken({ userId: user.id, email, domain });
    return { userId: user.id, token };
  }

  async function authHeaders(email: string) {
    const hash = await seedDomainSecret(handle!.prisma, DOMAIN);
    const { userId, token } = await seedCaller(email);
    return {
      userId,
      headers: { authorization: `Bearer ${hash}`, 'x-uoa-access-token': `Bearer ${token}` },
    };
  }

  const q = `?domain=${encodeURIComponent(DOMAIN)}`;

  it('stores a namespaced list of dictionaries and reads it back at every level', async () => {
    const { userId, headers } = await authHeaders('bookmarks@example.com');

    const put = await app!.inject({
      method: 'PUT',
      url: `/settings/me/browser/bookmarks${q}`,
      headers,
      payload: { value: BOOKMARKS },
    });
    expect(put.statusCode).toBe(200);
    expect(put.headers['cache-control']).toBe('no-store');
    expect(put.json()).toMatchObject({
      ok: true,
      namespace: 'browser',
      key: 'bookmarks',
      value: BOOKMARKS,
      updated_at: expect.any(String),
    });

    const key = await app!.inject({
      method: 'GET',
      url: `/settings/me/browser/bookmarks${q}`,
      headers,
    });
    expect(key.statusCode).toBe(200);
    expect(key.json()).toMatchObject({ namespace: 'browser', key: 'bookmarks', value: BOOKMARKS });

    const ns = await app!.inject({ method: 'GET', url: `/settings/me/browser${q}`, headers });
    expect(ns.json()).toMatchObject({
      ok: true,
      namespace: 'browser',
      settings: { bookmarks: BOOKMARKS },
    });

    const all = await app!.inject({ method: 'GET', url: `/settings/me${q}`, headers });
    expect(all.statusCode).toBe(200);
    expect(all.headers['cache-control']).toBe('no-store');
    const body = all.json();
    expect(body.namespaces).toEqual({ browser: { bookmarks: BOOKMARKS } });
    expect(body.usage).toMatchObject({
      entries: 1,
      size_bytes: Buffer.byteLength(JSON.stringify(BOOKMARKS), 'utf8'),
      max_entries: USER_SETTINGS_MAX_ENTRIES,
    });

    // The row belongs to the token subject, not to anyone named in the request.
    const stored = await handle!.prisma.userSetting.findMany({ select: { userId: true } });
    expect(stored).toEqual([{ userId }]);
  });

  it('PATCHes global key/value settings atomically, with null deleting a key', async () => {
    const { headers } = await authHeaders('global@example.com');
    const url = `/settings/me/global${q}`;

    const first = await app!.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { settings: { theme: 'dark', locale: 'en-GB', fontScale: 1.25, beta: true } },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().settings).toEqual({
      theme: 'dark',
      locale: 'en-GB',
      fontScale: 1.25,
      beta: true,
    });

    const second = await app!.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { settings: { theme: 'light', beta: null } },
    });
    expect(second.json().settings).toEqual({ theme: 'light', locale: 'en-GB', fontScale: 1.25 });

    // One oversized entry fails the whole PATCH, including the valid entry next to it.
    const big = 'x'.repeat(USER_SETTINGS_MAX_VALUE_BYTES);
    const rejected = await app!.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { settings: { theme: 'blue', huge: big } },
    });
    expect(rejected.statusCode).toBe(413);
    expectJsonError(rejected.json(), { code: 'SETTING_VALUE_TOO_LARGE' });

    const after = await app!.inject({ method: 'GET', url, headers });
    expect(after.json().settings).toEqual({ theme: 'light', locale: 'en-GB', fontScale: 1.25 });
  });

  it('deletes keys and namespaces idempotently and 404s a missing key', async () => {
    const { headers } = await authHeaders('delete@example.com');
    await app!.inject({
      method: 'PATCH',
      url: `/settings/me/app.one${q}`,
      headers,
      payload: { settings: { a: 1, b: 2, c: 3 } },
    });

    const delKey = await app!.inject({
      method: 'DELETE',
      url: `/settings/me/app.one/a${q}`,
      headers,
    });
    expect(delKey.json()).toEqual({ ok: true });
    const again = await app!.inject({
      method: 'DELETE',
      url: `/settings/me/app.one/a${q}`,
      headers,
    });
    expect(again.statusCode).toBe(200);

    const missing = await app!.inject({
      method: 'GET',
      url: `/settings/me/app.one/a${q}`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expectJsonError(missing.json());

    const delNs = await app!.inject({ method: 'DELETE', url: `/settings/me/app.one${q}`, headers });
    expect(delNs.json()).toEqual({ ok: true, deleted: 2 });

    const empty = await app!.inject({ method: 'GET', url: `/settings/me/app.one${q}`, headers });
    expect(empty.json()).toEqual({
      ok: true,
      namespace: 'app.one',
      settings: {},
      updated_at: null,
    });
  });

  it('rejects malformed names and unstorable values without writing anything', async () => {
    const { headers } = await authHeaders('invalid@example.com');

    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) deep = [deep];

    const cases: Array<{ method: 'PUT' | 'PATCH'; url: string; payload: unknown }> = [
      { method: 'PUT', url: `/settings/me/Browser/bookmarks${q}`, payload: { value: 1 } },
      { method: 'PUT', url: `/settings/me/browser/_hidden${q}`, payload: { value: 1 } },
      { method: 'PUT', url: `/settings/me/browser/bookmarks${q}`, payload: { value: null } },
      { method: 'PUT', url: `/settings/me/browser/bookmarks${q}`, payload: {} },
      { method: 'PUT', url: `/settings/me/browser/bookmarks${q}`, payload: { value: 'a\u0000b' } },
      { method: 'PUT', url: `/settings/me/browser/bookmarks${q}`, payload: { value: '\ud800' } },
      { method: 'PUT', url: `/settings/me/browser/bookmarks${q}`, payload: { value: deep } },
      { method: 'PATCH', url: `/settings/me/global${q}`, payload: { settings: {} } },
      { method: 'PATCH', url: `/settings/me/global${q}`, payload: { settings: { 'bad key': 1 } } },
    ];

    for (const c of cases) {
      const res = await app!.inject({
        method: c.method,
        url: c.url,
        headers,
        payload: c.payload as object,
      });
      expect(res.statusCode, `${c.method} ${c.url} ${JSON.stringify(c.payload).slice(0, 60)}`).toBe(
        400,
      );
      expectJsonError(res.json());
    }

    expect(await handle!.prisma.userSetting.count()).toBe(0);
  });

  it('enforces the per-user quota and lets existing keys be rewritten at the cap', async () => {
    const { userId, headers } = await authHeaders('quota@example.com');
    await handle!.prisma.userSetting.createMany({
      data: Array.from({ length: USER_SETTINGS_MAX_ENTRIES }, (_, i) => ({
        userId,
        namespace: 'filler',
        key: `k${i}`,
        value: i,
        sizeBytes: String(i).length,
      })),
    });

    const over = await app!.inject({
      method: 'PUT',
      url: `/settings/me/global/theme${q}`,
      headers,
      payload: { value: 'dark' },
    });
    expect(over.statusCode).toBe(413);
    expectJsonError(over.json(), { code: 'SETTINGS_QUOTA_EXCEEDED' });
    expect(await handle!.prisma.userSetting.count({ where: { userId } })).toBe(
      USER_SETTINGS_MAX_ENTRIES,
    );

    const rewrite = await app!.inject({
      method: 'PUT',
      url: `/settings/me/filler/k0${q}`,
      headers,
      payload: { value: 'still fits' },
    });
    expect(rewrite.statusCode).toBe(200);
  });

  it('serializes concurrent writers so the quota cannot be raced past', async () => {
    const { userId } = await authHeaders('race@example.com');
    await handle!.prisma.userSetting.createMany({
      data: Array.from({ length: USER_SETTINGS_MAX_ENTRIES - 1 }, (_, i) => ({
        userId,
        namespace: 'filler',
        key: `k${i}`,
        value: i,
        sizeBytes: String(i).length,
      })),
    });

    // Hold every writer open between its quota check and its commit. Without the per-user lock
    // all of them would count only their own uncommitted row, pass, and commit.
    const real = handle!.prisma;
    const prisma = {
      userSetting: real.userSetting,
      $transaction: ((fn: (tx: unknown) => Promise<unknown>) =>
        real.$transaction(async (tx) => {
          const aggregate = tx.userSetting.aggregate.bind(tx.userSetting);
          const slowTx = Object.create(tx, {
            userSetting: {
              value: Object.assign(Object.create(tx.userSetting), {
                aggregate: async (args: Parameters<typeof aggregate>[0]) => {
                  const usage = await aggregate(args);
                  await new Promise((resolve) => setTimeout(resolve, 150));
                  return usage;
                },
              }),
            },
          });
          return fn(slowTx);
        })) as typeof real.$transaction,
    };

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        updateUserSettings({ userId, namespace: 'race', entries: { [`key${i}`]: i } }, { prisma }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ statusCode: 413 });
    }
    expect(await real.userSetting.count({ where: { userId } })).toBe(USER_SETTINGS_MAX_ENTRIES);
  });

  it("keeps each user's settings separate and requires both credentials", async () => {
    const hash = await seedDomainSecret(handle!.prisma, DOMAIN);
    const alice = await seedCaller('alice@example.com');
    const bob = await seedCaller('bob@example.com');
    const as = (token: string) => ({
      authorization: `Bearer ${hash}`,
      'x-uoa-access-token': `Bearer ${token}`,
    });

    await app!.inject({
      method: 'PUT',
      url: `/settings/me/global/theme${q}`,
      headers: as(alice.token),
      payload: { value: 'dark' },
    });

    const bobView = await app!.inject({
      method: 'GET',
      url: `/settings/me${q}`,
      headers: as(bob.token),
    });
    expect(bobView.json().namespaces).toEqual({});

    const noToken = await app!.inject({
      method: 'GET',
      url: `/settings/me${q}`,
      headers: { authorization: `Bearer ${hash}` },
    });
    expect(noToken.statusCode).toBe(401);

    const noHash = await app!.inject({
      method: 'GET',
      url: `/settings/me${q}`,
      headers: { 'x-uoa-access-token': `Bearer ${alice.token}` },
    });
    expect(noHash.statusCode).toBe(401);
  });

  it('rejects an access token minted for a different domain', async () => {
    const hash = await seedDomainSecret(handle!.prisma, DOMAIN);
    await seedDomainSecret(handle!.prisma, OTHER_DOMAIN);
    const other = await seedCaller('elsewhere@example.com', OTHER_DOMAIN);

    const res = await app!.inject({
      method: 'PUT',
      url: `/settings/me/global/theme${q}`,
      headers: { authorization: `Bearer ${hash}`, 'x-uoa-access-token': `Bearer ${other.token}` },
      payload: { value: 'dark' },
    });
    expect(res.statusCode).toBe(403);
    expect(await handle!.prisma.userSetting.count()).toBe(0);
  });
});
