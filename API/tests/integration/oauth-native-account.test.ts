import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { hashPassword } from '../../src/services/password.service.js';
import { signMcpAccessToken, signConfidentialAccessToken, resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';

const issuer = 'https://auth.example.com';
const domain = 'native.example.com';
const redirect = 'com.unlikeotherai.kelpie://oauth/callback';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const scope = 'openid profile settings.read settings.write';
const path = '/oauth/me/settings/browser/bookmarks';

function totp(secret: Buffer): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  return ((digest.readUInt32BE(digest[19]! & 15) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

describe.skipIf(!process.env.DATABASE_URL)('native account PKCE and durable favourites', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let clientID: string;
  let userID: string;
  let token: string;
  const previous = { ...process.env };
  beforeAll(async () => {
    handle = (await createTestDb())!;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
    process.env.MCP_OAUTH_PUBLIC_PROFILE_ENABLED = 'true';
    process.env.MCP_OAUTH_DOMAIN = domain;
    process.env.PUBLIC_BASE_URL = issuer;
    const { privateKey } = await generateKeyPair('RS256');
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(privateKey), kid: 'native-test' });
    resetAccessTokenKeyCache();
    const user = await handle.prisma.user.create({ data: {
      email: 'native@example.com', userKey: 'native@example.com', name: 'Native Test',
      passwordHash: await hashPassword('NativePassword1!'),
    } });
    userID = user.id;
    app = await createApp();
    await app.ready();
    const registration = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      client_name: 'Kelpie', redirect_uris: [redirect], scope, token_endpoint_auth_method: 'none',
    } });
    expect(registration.statusCode, registration.body).toBe(201);
    clientID = registration.json().client_id;
  });
  afterAll(async () => {
    await app?.close();
    await handle?.cleanup();
    process.env = previous;
    resetAccessTokenKeyCache();
  });

  function loginURL(extraScope = scope) {
    return '/oauth/login?' + new URLSearchParams({ client_id: clientID, redirect_uri: redirect,
      state: 'native-state', scope: extraScope, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  }
  const credentials = { email: 'native@example.com', password: 'NativePassword1!' };
  function headers(value = token) { return { authorization: `Bearer ${value}` }; }

  it('renders consent, completes login, redeems once and returns the authoritative profile/avatar', async () => {
    const authorize = await app.inject({ method: 'GET', url: loginURL().replace('/login?', '/authorize?') });
    expect(authorize.statusCode, authorize.body).toBe(200);
    const login = await app.inject({ method: 'POST', url: loginURL(), payload: credentials });
    expect(login.statusCode, login.body).toBe(200);
    const callback = new URL(login.json().redirect_to);
    expect(callback.searchParams.get('state')).toBe('native-state');
    const payload = { code: callback.searchParams.get('code'), client_id: clientID, redirect_uri: redirect, code_verifier: verifier };
    const exchange = await app.inject({ method: 'POST', url: '/oauth/token', payload });
    expect(exchange.statusCode, exchange.body).toBe(200);
    token = exchange.json().access_token;
    expect((await app.inject({ method: 'POST', url: '/oauth/token', payload })).statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/oauth/me', headers: headers() });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json()).toEqual({ sub: userID, email: credentials.email, name: 'Native Test' });
    const avatar = await app.inject({ method: 'GET', url: '/oauth/me/avatar', headers: headers() });
    expect(avatar.statusCode, avatar.body).toBe(200);
    expect(avatar.headers['cache-control']).toBe('no-store');
  });

  it('persists in the shared user store and rejects stale concurrent writes and missing preconditions', async () => {
    const read = await app.inject({ method: 'GET', url: path, headers: headers() });
    expect(read.json()).toEqual({ value: null });
    const value = [{ title: 'Example', url: 'https://example.com/' }];
    const save = await app.inject({ method: 'PUT', url: path, headers: { ...headers(), 'if-match': read.headers.etag! }, payload: { value } });
    expect(save.statusCode, save.body).toBe(200);
    expect((await handle.prisma.userSetting.findUnique({ where: { userId_namespace_key: { userId: userID, namespace: 'browser', key: 'bookmarks' } } }))?.value).toEqual(value);
    const stale = await app.inject({ method: 'PUT', url: path, headers: { ...headers(), 'if-match': read.headers.etag! }, payload: { value: [] } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: path, headers: headers(), payload: { value: [] } })).statusCode).toBe(428);
  });

  it('streams a committed change across app instances, then a delta and deletion', async () => {
    const replica = await createApp();
    const address = await replica.listen({ port: 0, host: '127.0.0.1' });
    // Exercise an actual upgrade: injectWS does not provide the underlying TCP socket.
    const socket = new WebSocket(address.replace('http:', 'ws:') + path + '/events', { headers: headers() });
    const second = new WebSocket(address.replace('http:', 'ws:') + path + '/events', { headers: headers() });
    const frames: Record<string, unknown>[] = [];
    const secondFrames: Record<string, unknown>[] = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    second.on('message', data => secondFrames.push(JSON.parse(data.toString())));
    try {
      await Promise.all([socket, second].map(client => new Promise<void>((resolve, reject) => {
        client.once('open', resolve); client.once('error', reject);
      })));
      // Streams coalesce pending reads. Pace writes on both clients when checking
      // each intermediate delta; one client receiving it does not fence the other.
      await expect.poll(() => frames.length).toBe(1);
      await expect.poll(() => secondFrames.length).toBe(1);
      expect(frames[0]).toMatchObject({ type: 'settings.snapshot', namespace: 'browser', key: 'bookmarks' });
      const value = Array.from({ length: 100 }, (_, id) => ({ id, title: `Page ${id}`, url: 'https://example.com' }));
      let read = await app.inject({ method: 'GET', url: path, headers: headers() });
      const save = await app.inject({ method: 'PUT', url: path, headers: { ...headers(), 'if-match': read.headers.etag! }, payload: { value } });
      expect(save.statusCode).toBe(200);
      await expect.poll(() => frames.length).toBe(2);
      await expect.poll(() => secondFrames.length).toBe(2);
      expect(frames[1]).toMatchObject({ type: 'settings.delta', baseVersion: frames[0]!.version, version: save.headers.etag });
      value[50]!.title = 'Renamed';
      read = await app.inject({ method: 'GET', url: path, headers: headers() });
      await app.inject({ method: 'PUT', url: path, headers: { ...headers(), 'if-match': read.headers.etag! }, payload: { value } });
      await expect.poll(() => frames.length).toBe(3);
      await expect.poll(() => secondFrames.length).toBe(3);
      expect(frames[2]!.operation).toMatchObject({ type: 'splice', index: 50, deleteCount: 1 });
      // A different writer deleting the namespace still fires the database trigger.
      await handle.prisma.userSetting.deleteMany({ where: { userId: userID, namespace: 'browser' } });
      await expect.poll(() => frames.length).toBe(4);
      expect(frames[3]!.operation).toEqual({ type: 'replace', value: null });
      await expect.poll(() => secondFrames.length).toBe(4);
      expect(secondFrames).toEqual(frames);
      const reconnect = new WebSocket(address.replace('http:', 'ws:') + path + '/events', { headers: headers() });
      try {
        const snapshot = await new Promise<unknown>((resolve, reject) => {
          reconnect.once('message', data => resolve(JSON.parse(data.toString())));
          reconnect.once('error', reject);
        });
        expect(snapshot).toMatchObject({ type: 'settings.snapshot', value: null, version: frames[3]!.version });
        // Sending application messages is unsupported and must close, not mutate.
        const closed = new Promise<number>(resolve => reconnect.once('close', resolve));
        reconnect.send(JSON.stringify({ value: ['unauthorised write'] }));
        expect(await closed).toBe(1008);
      } finally { reconnect.terminate(); }
    } finally { socket.terminate(); second.terminate(); await replica.close(); }
  });

  it('refuses unauthenticated streams and user-selection query parameters', async () => {
    await expect(app.injectWS(path + '/events')).rejects.toThrow();
    await expect(app.injectWS(path + '/events?userId=other', { headers: headers() })).rejects.toThrow();
  });

  it('bounds subscriptions per subject and releases admission after disconnect', async () => {
    const replica = await createApp();
    const address = await replica.listen({ port: 0, host: '127.0.0.1' });
    const url = address.replace('http:', 'ws:') + path + '/events';
    const sockets: WebSocket[] = [];
    const connect = async () => {
      const socket = new WebSocket(url, { headers: headers() });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('message', () => resolve()); socket.once('error', reject);
      });
      return socket;
    };
    try {
      await Promise.all(Array.from({ length: 8 }, connect));
      const denied = new WebSocket(url, { headers: headers() });
      sockets.push(denied);
      expect(await new Promise<number>((resolve, reject) => {
        denied.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); });
        denied.once('open', () => reject(new Error('Admission exceeded')));
        denied.once('error', () => {});
      })).toBe(503);
      const first = sockets[0]!;
      await new Promise<void>(resolve => { first.once('close', () => resolve()); first.close(); });
      await connect();
      expect((await app.inject({ method: 'GET', url: '/oauth/me', headers: headers() })).statusCode).toBe(200);
    } finally { sockets.forEach(socket => socket.terminate()); await replica.close(); }
  });

  it('closes a revoked stream before sending another settings value', async () => {
    const subject = await handle.prisma.user.create({ data: { email: 'stream-revocation@example.com', userKey: 'stream-revocation@example.com' } });
    const access = await signMcpAccessToken({ subject: subject.id, email: subject.email, domain, clientId: clientID,
      credentialEpoch: 0, role: 'user', resource: issuer, issuer, ttlSeconds: 600, scope });
    const replica = await createApp();
    const address = await replica.listen({ port: 0, host: '127.0.0.1' });
    const socket = new WebSocket(address.replace('http:', 'ws:') + path + '/events', { headers: headers(access) });
    const frames: unknown[] = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      await expect.poll(() => frames.length).toBe(1);
      const closed = new Promise<number>(resolve => socket.once('close', resolve));
      await handle.prisma.user.update({ where: { id: subject.id }, data: { tokenVersion: { increment: 1 } } });
      const value = ['after revocation'];
      await handle.prisma.userSetting.create({ data: { userId: subject.id, namespace: 'browser', key: 'bookmarks', value,
        sizeBytes: Buffer.byteLength(JSON.stringify(value)) } });
      expect(await closed).toBe(1008);
      expect(frames).toHaveLength(1);
    } finally { socket.terminate(); await replica.close(); }
  });

  it('rejects scope escalation, other token classes, wrong audience, missing epoch and cross-user reads', async () => {
    const claims = { subject: userID, email: credentials.email, domain, clientId: clientID,
      credentialEpoch: 0, role: 'user' as const, resource: issuer, issuer, ttlSeconds: 600, scope };
    expect((await app.inject({ method: 'POST', url: loginURL(scope + ' admin'), payload: credentials })).statusCode).toBe(400);
    const narrow = await signMcpAccessToken({ ...claims, scope: 'profile' });
    expect((await app.inject({ method: 'GET', url: path, headers: headers(narrow) })).statusCode).toBe(403);
    const wrong = await signMcpAccessToken({ ...claims, resource: 'https://other.example.com' });
    expect((await app.inject({ method: 'GET', url: path, headers: headers(wrong) })).statusCode).toBe(401);
    const missing = await signMcpAccessToken({ ...claims, credentialEpoch: undefined as never });
    expect((await app.inject({ method: 'GET', url: path, headers: headers(missing) })).statusCode).toBe(401);
    const confidential = await signConfidentialAccessToken({ ...claims, sourceDomain: domain, product: 'kelpie' });
    expect((await app.inject({ method: 'GET', url: path, headers: headers(confidential) })).statusCode).toBe(401);
    const other = await handle.prisma.user.create({ data: { email: 'other@example.com', userKey: 'other@example.com' } });
    const otherToken = await signMcpAccessToken({ ...claims, subject: other.id });
    expect((await app.inject({ method: 'GET', url: path + '?userId=' + userID, headers: headers(otherToken) })).json()).toEqual({ value: null });
  });

  it('honours enrolled TOTP, rejects replay and invalidates access on credential revocation', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await handle.prisma.user.update({ where: { id: userID }, data: { twoFaEnabled: true,
      twoFaSecret: encryptTwoFaSecret({ secret, sharedSecret: process.env.SHARED_SECRET! }) } });
    const pending = await app.inject({ method: 'POST', url: loginURL(), payload: credentials });
    expect(pending.json()).toMatchObject({ twofa_required: true });
    const payload = { ...credentials, code: totp(Buffer.from('12345678901234567890')) };
    const completed = await app.inject({ method: 'POST', url: loginURL(), payload });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().redirect_to).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: loginURL(), payload })).statusCode).toBe(401);
    await handle.prisma.user.update({ where: { id: userID }, data: { tokenVersion: { increment: 1 } } });
    expect((await app.inject({ method: 'GET', url: '/oauth/me', headers: headers() })).statusCode).toBe(401);
  });
  it('binds required enrollment to the exact authorization request', async () => {
    await handle.prisma.clientDomain.upsert({ where: { domain }, create: { domain, label: 'Native', twoFaPolicy: 'REQUIRED' }, update: { twoFaPolicy: 'REQUIRED' } });
    await handle.prisma.user.update({ where: { id: userID }, data: { twoFaEnabled: false, twoFaSecret: null, twoFaLastAcceptedCounter: null } });
    const pending = await app.inject({ method: 'POST', url: loginURL(), payload: credentials });
    expect(pending.statusCode, pending.body).toBe(200);
    const setup = pending.json();
    expect(setup.twofa_enroll_required).toBe(true);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [...setup.manual_secret as string].map((character) => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('');
    const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
    const payload = { ...credentials, setup_token: setup.setup_token, code: totp(bytes) };
    const retargeted = await app.inject({ method: 'POST', url: loginURL().replace('native-state', 'other-state'), payload });
    expect(retargeted.statusCode).toBe(401);
    const completed = await app.inject({ method: 'POST', url: loginURL(), payload });
    expect(completed.statusCode, completed.body).toBe(200);
    const callback = new URL(completed.json().redirect_to);
    const exchange = await app.inject({ method: 'POST', url: '/oauth/token', payload: {
      code: callback.searchParams.get('code'), client_id: clientID, redirect_uri: redirect, code_verifier: verifier,
    } });
    expect(exchange.statusCode, exchange.body).toBe(200);
    const read = await app.inject({ method: 'GET', url: path, headers: headers(exchange.json().access_token) });
    expect(read.statusCode, read.body).toBe(200);
  });

});
