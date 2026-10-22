import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mailbox = vi.hoisted(() => ({ messages: [] as Array<{ to: string; link: string; code: string }> }));
vi.mock('../../src/services/email.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/email.service.js')>(),
  sendRegistrationVerificationEmail: async (message: { to: string; link: string; code: string }) => { mailbox.messages.push(message); },
}));
vi.mock('../../src/services/ban-policy.service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/ban-policy.service.js')>(),
  isPrincipalBannedForRegistration: async () => false,
}));

import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { createTestConfigFetchHandler, signTestConfigJwt } from '../helpers/test-config.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { registrationCookieName } from '../../src/services/registration-credentials.js';

describe('browser-bound pending registration', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  const originalDb = process.env.DATABASE_URL;
  const originalAdminDb = process.env.DATABASE_ADMIN_URL;
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  const query = new URLSearchParams({ config_url: 'https://client.example.com/auth-config',
    code_challenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', code_challenge_method: 'S256', state: 'csrf-registered-flow' });
  const origin = 'http://127.0.0.1:38571';
  let sequence = 0;

  beforeAll(async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for registration persistence tests');
    db = handle;
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.DATABASE_ADMIN_URL = db.databaseUrl;
    process.env.PUBLIC_BASE_URL = origin;
    const jwt = await signTestConfigJwt();
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));
    app = await createApp(); await app.ready();
  });
  beforeEach(() => { mailbox.messages.length = 0; });
  afterAll(async () => {
    await app?.close(); await disconnectPrisma();
    if (originalDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDb;
    if (originalAdminDb === undefined) delete process.env.DATABASE_ADMIN_URL; else process.env.DATABASE_ADMIN_URL = originalAdminDb;
    if (originalPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
    vi.unstubAllGlobals();
    if (db) await db.cleanup();
  });

  async function start() {
    sequence += 1;
    const email = `registration-${sequence}@example.com`;
    const response = await app.inject({ method: 'POST', url: `/auth/registration/start?${query}`, payload: { email },
      headers: { origin, 'x-forwarded-for': `192.0.2.${sequence}` } });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().registration_id as string;
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    expect(cookie).toContain(registrationCookieName(id));
    expect(String(response.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(response.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
    expect(mailbox.messages.at(-1)?.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    return { id, cookie, email, message: mailbox.messages.at(-1)! };
  }
  type Flow = Awaited<ReturnType<typeof start>>;
  function status(flow: Flow, cookie = flow.cookie, suffix = '') {
    return app.inject({ method: 'GET', url: `/auth/registration/status?${query}&id=${flow.id}${suffix}`, headers: { cookie, origin } });
  }
  function link(flow: Flow, cookie = '') {
    return app.inject({ method: 'POST', url: '/auth/registration/link',
      payload: { token: new URL(flow.message.link).hash.slice(1) }, headers: { cookie, origin, 'x-forwarded-for': `198.51.100.${sequence}` } });
  }
  function code(flow: Flow, value = flow.message.code, cookie = flow.cookie) {
    return app.inject({ method: 'POST', url: `/auth/registration/code?${query}`,
      payload: { id: flow.id, code: value }, headers: { cookie, origin, 'x-forwarded-for': `192.0.2.${sequence}` } });
  }

  it('notifies and authorizes the original browser when another device confirms, without signing that device in', async () => {
    const flow = await start();
    let resolveMessage!: (value: string) => void;
    const messagePromise = new Promise<string>(resolve => { resolveMessage = resolve; });
    const socket = await app.injectWS(`/auth/registration/events?${query}&id=${flow.id}`, {
      headers: { cookie: flow.cookie, origin },
    }, { onInit: client => { client.on('message', value => resolveMessage(String(value))); } });
    const result = await link(flow);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ status: 'verified' });
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers.location).toBeUndefined();
    expect(JSON.parse(await messagePromise)).toEqual({ type: 'registration.email_verified', status: 'verified' });
    socket.close();
    expect((await status(flow)).json()).toMatchObject({ status: 'authorized', token_type: 'VERIFY_EMAIL_SET_PASSWORD' });
    expect(await db.prisma.user.count({ where: { email: flow.email } })).toBe(0);
    expect((await status(flow, '')).statusCode).toBe(400);
    const counts = await db.prisma.authFunnelDailyCount.findMany({ where: { domain: 'client.example.com' } });
    expect(counts).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'register_submitted', outcome: 'valid_email', count: 1 }),
      expect.objectContaining({ step: 'registration_email', outcome: 'verification_sent', count: 1 }),
      expect.objectContaining({ step: 'email_link_opened', outcome: 'registration_verified', count: 1 }),
    ]));
  });
  it('opening an unsolicited link or preview does not approve registration before explicit confirmation', async () => {
    const flow = await start();
    const landing = await app.inject({ method: 'GET', url: '/auth/registration/link' });
    expect(landing.body).toContain('Only confirm if you requested this registration');
    expect((await status(flow)).json()).not.toHaveProperty('token');
    expect((await code(flow, 'AAAAAA')).statusCode).toBe(400);
    expect((await status(flow)).json().status).toBe('pending');
  });
  it('also accepts same-browser confirmation and preserves original PKCE/state', async () => {
    const flow = await start();
    expect((await link(flow, flow.cookie)).statusCode).toBe(200);
    const current = await status(flow);
    expect(current.json()).toMatchObject({ status: 'authorized', token_type: 'VERIFY_EMAIL_SET_PASSWORD' });
    expect(current.json().token).toMatch(/^registration\./);
    const changed = new URLSearchParams(query); changed.set('state', 'another-flow');
    const denied = await app.inject({ method: 'GET', url: `/auth/registration/status?${changed}&id=${flow.id}`, headers: { cookie: flow.cookie } });
    expect(denied.statusCode).toBe(400);
    const completion = await app.inject({ method: 'POST', url: `/auth/verify-email?${query}`,
      payload: { token: current.json().token, password: 'a-strong-password-123' }, headers: { origin } });
    expect(completion.statusCode).toBe(400); // Even a copied proof needs its original cookie.
  });
  it('accepts the alternative code only in the requesting browser', async () => {
    const flow = await start();
    expect((await code(flow, flow.message.code, '')).statusCode).toBe(400);
    expect((await code(flow)).json()).toMatchObject({ status: 'authorized' });
    expect((await status(flow)).json()).toMatchObject({ status: 'authorized' }); // refresh recovery
  });
  it('persists at most five guesses across concurrent requests', async () => {
    const flow = await start();
    const attempts = await Promise.all(Array.from({ length: 5 }, () => code(flow, '!!!!!!')));
    expect(attempts.every(result => result.statusCode === 400)).toBe(true);
    expect((await db.prisma.pendingRegistration.findUniqueOrThrow({ where: { id: flow.id } })).attempts).toBe(5);
    expect((await code(flow)).statusCode).toBe(400);
    expect((await status(flow)).json()).toEqual({ status: 'expired' });
    expect((await link(flow)).statusCode).toBe(400);
  });
  it('never transfers link approval to a different registration or the browser replaying it', async () => {
    const flow = await start();
    await link(flow);
    const proof = (await status(flow)).json().token;
    const unrelated = await start();
    const replay = await link(flow, unrelated.cookie);
    expect(replay.json()).toEqual({ status: 'verified' });
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect((await status(flow)).json()).toMatchObject({ status: 'authorized', token: proof });
    expect((await status(unrelated)).json()).toEqual({ status: 'pending' });
    expect((await status(flow, unrelated.cookie)).statusCode).toBe(400);
  });
  it('converges link and code races on one pending registration', async () => {
    const flow = await start();
    const results = await Promise.all([link(flow), code(flow)]);
    expect(results.every(result => result.statusCode === 200)).toBe(true);
    const row = await db.prisma.pendingRegistration.findUniqueOrThrow({ where: { id: flow.id } });
    expect(row.emailVerifiedAt).not.toBeNull(); expect(row.browserAuthorizedAt).not.toBeNull();
    expect((await code(flow)).json()).toMatchObject({ status: 'authorized' });
  });
  it('rejects an expired link and code without creating identity state', async () => {
    const flow = await start();
    await db.prisma.pendingRegistration.update({ where: { id: flow.id }, data: { expiresAt: new Date(0) } });
    expect((await link(flow)).statusCode).toBe(400);
    expect((await code(flow)).statusCode).toBe(400);
    expect(await db.prisma.user.count({ where: { email: flow.email } })).toBe(0);
  });
  it('sends secret-free websocket hints and rechecks already-verified state at subscription', async () => {
    const flow = await start();
    await link(flow);
    let resolveMessage!: (value: string) => void;
    const messagePromise = new Promise<string>(resolve => { resolveMessage = resolve; });
    const socket = await app.injectWS(`/auth/registration/events?${query}&id=${flow.id}`, {
      headers: { cookie: flow.cookie, origin },
    }, { onInit: client => { client.on('message', value => resolveMessage(String(value))); } });
    const message = await messagePromise;
    expect(JSON.parse(message)).toEqual({ type: 'registration.email_verified', status: 'verified' });
    socket.close();
  });
  it('refuses unauthenticated websocket upgrades and cross-origin subscriptions', async () => {
    const flow = await start();
    await expect(app.injectWS(`/auth/registration/events?${query}&id=${flow.id}`, { headers: { origin } })).rejects.toThrow();
    await expect(app.injectWS(`/auth/registration/events?${query}&id=${flow.id}`, { headers: { origin: 'https://evil.example', cookie: flow.cookie } })).rejects.toThrow();
  });
  it('serves an isolated confirmation page without consuming a link on GET', async () => {
    const result = await app.inject({ method: 'GET', url: '/auth/registration/link' });
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Email verified');
    expect(result.body).toContain('history.replaceState');
    expect(result.body).not.toContain('<img');
    expect(result.headers['referrer-policy']).toBe('no-referrer');
    expect(result.headers['content-security-policy']).toContain("default-src 'none'");
  });
  it('creates one account and one authorization code when completion is retried concurrently', async () => {
    const flow = await start();
    await link(flow);
    const proof = (await status(flow)).json().token;
    const foreignCompletion = await app.inject({ method: 'POST', url: `/auth/verify-email?${query}`,
      payload: { token: proof, password: 'a-strong-password-123' }, headers: { origin } });
    expect(foreignCompletion.statusCode).toBe(400);
    const complete = () => app.inject({ method: 'POST', url: `/auth/verify-email?${query}`,
      payload: { token: proof, password: 'a-strong-password-123' }, headers: { cookie: flow.cookie, origin, 'x-forwarded-for': `198.51.100.${sequence}` } });
    const outcomes = await Promise.all([complete(), complete()]);
    const successes = outcomes.filter(result => result.statusCode === 200);
    expect(successes, outcomes.map(result => result.body).join('\n')).toHaveLength(1);
    expect(new URL(successes[0].json().redirect_to).searchParams.get('state')).toBe('csrf-registered-flow');
    const user = await db.prisma.user.findFirstOrThrow({ where: { email: flow.email } });
    expect(await db.prisma.user.count({ where: { email: flow.email } })).toBe(1);
    expect(await db.prisma.authorizationCode.count({ where: { userId: user.id } })).toBe(1);
    expect((await status(flow)).json()).toEqual({ status: 'complete' });
  });
});
