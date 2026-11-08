import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { issueSessionAssurance } from '../../src/services/session-assurance.service.js';
import { resetAccessTokenKeyCache } from '../../src/services/oauth/access-token.service.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { baseClientConfigPayload, signTestConfigJwt, createTestConfigFetchHandler, TEST_SHARED_SECRET } from '../helpers/test-config.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/services/jwks-fetch.service.js', async original => ({
  ...await original<typeof import('../../src/services/jwks-fetch.service.js')>(), fetchPartnerJwks: transport.fetch,
}));

describe('embedded Kelpie original host authority with PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const previous = { ...process.env };
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
  beforeAll(async () => {
    const created = await createTestDb(); if (!created) throw new Error('Real isolated DATABASE_URL required');
    handle = created;
    Object.assign(process.env, { DATABASE_URL: handle.databaseUrl, DATABASE_ADMIN_URL: handle.databaseUrl,
      SHARED_SECRET: TEST_SHARED_SECRET, PUBLIC_BASE_URL: 'https://auth.example.com',
      MCP_OAUTH_PUBLIC_PROFILE_ENABLED: 'false', DEBUG_ENABLED: 'false' });
    const key = await generateKeyPair('RS256', { extractable: true });
    process.env.MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK = JSON.stringify({ ...await exportJWK(key.privateKey), kid: 'embedded-test' });
    resetAccessTokenKeyCache();
  });
  afterAll(async () => {
    await Promise.all(apps.map(app => app.close())); await disconnectPrisma(); await handle?.cleanup();
    process.env = previous; resetAccessTokenKeyCache(); vi.unstubAllGlobals();
  });
  async function fixture() {
    const db = handle.prisma; const domain = `host-${randomUUID()}.example.com`;
    const resource = `https://${domain}/api/kelpie/connect`; process.env.KELPIE_CONNECT_RESOURCE = resource;
    const domainHash = await seedDomainSecret(db, domain, TEST_SHARED_SECRET);
    const client = await db.clientDomain.findUniqueOrThrow({ where: { domain } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, userKey: randomUUID() } });
    await db.domainRole.create({ data: { domain, userId: user.id, role: 'USER' } });
    const org = await db.organisation.create({ data: { domain, ownerId: user.id, name: 'Host', slug: randomUUID() } });
    const team = await db.team.create({ data: { orgId: org.id, name: 'Host', slug: randomUUID(), isDefault: true } });
    await db.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await db.teamMember.create({ data: { teamId: team.id, userId: user.id, teamRole: 'owner' } });
    const familyId = randomUUID(); const expiresAt = new Date(Date.now() + 600_000);
    await db.refreshToken.create({ data: { familyId, userId: user.id, domain, clientId: domainHash,
      configUrl: `https://${domain}/config`, orgId: org.id, teamId: team.id, tokenHash: randomUUID(),
      expiresAt: new Date(expiresAt.getTime() + 1000) } });
    const proof = await db.$transaction(tx => issueSessionAssurance({ familyId, userId: user.id, clientDomain: domain,
      credentialEpoch: 0, orgId: org.id, teamId: team.id, method: 'independent', observedAt: new Date(),
      authenticatedAt: null, mfaSource: 'none', amr: ['pwd'], expiresAt, policyGeneration: 0 }, tx));
    const key = await generateKeyPair('RS256'); const jwk = { ...await exportJWK(key.publicKey), kid: 'source', alg: 'RS256', use: 'sig' };
    transport.fetch.mockResolvedValue({ keys: [jwk] });
    const configUrl = `https://${domain}/config`;
    const config = await signTestConfigJwt(baseClientConfigPayload({ domain, jwks_url: `https://${domain}/jwks`,
      redirect_urls: [`https://${domain}/callback`], org_features: { enabled: true } }));
    vi.stubGlobal('fetch', await createTestConfigFetchHandler({ [configUrl]: config }));
    const app = await createApp(); apps.push(app); await app.ready();
    const assertion = async (extra: Record<string, unknown> = {}) => new SignJWT({ source_domain: domain, tv: 0,
      active: { orgId: org.id, teamId: team.id }, assurance_ref: proof.reference, assurance_version: 1, ...extra })
      .setProtectedHeader({ alg: 'RS256', kid: 'source' }).setIssuer(domain)
      .setAudience('https://authentication.unlikeotherai.com/org').setSubject(user.id)
      .setIssuedAt().setExpirationTime('60s').setJti(randomUUID()).sign(key.privateKey);
    const grant = async (extra: Record<string, unknown> = {}, backend = domainHash) => app.inject({ method: 'POST',
      url: `/org/me/kelpie/session?domain=${domain}&config_url=${encodeURIComponent(configUrl)}`,
      headers: { authorization: `Bearer ${backend}`, 'x-uoa-subject-assertion': await assertion(extra) }, payload: {} });
    const request = (token: string, url = '/embedded/kelpie/me') => app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    const connect = (token: string) => app.inject({ method: 'POST', url: '/embedded/kelpie/connect',
      headers: { authorization: `Bearer ${token}` }, payload: { resource } });
    const validate = (ticket: string) => app.inject({ method: 'POST',
      url: `/embedded/kelpie/connect/validate?domain=${domain}`, headers: { authorization: `Bearer ${domainHash}` }, payload: { ticket } });
    const session = async () => { const result = await grant(); expect(result.statusCode, result.body).toBe(200); return result.json().access_token as string; };
    return { db, app, domain, resource, user, org, team, client, familyId, proof, grant, request, connect, validate, session };
  }
  it('uses original proof with the public native profile disabled and creates no native registration or refresh family', async () => {
    const f = await fixture(); const token = await f.session(); const claims = decodeJwt(token);
    expect(claims).toMatchObject({ sub: f.user.id, token_use: 'embedded_kelpie_account', domain: f.domain,
      client_domain_id: f.client.id, assurance_id: f.proof.assurance.id });
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(120);
    for (const field of ['email', 'name', 'avatar', 'refresh_token', 'assurance_ref', 'client_id', 'app_id']) expect(claims).not.toHaveProperty(field);
    expect(await f.db.refreshToken.count({ where: { userId: f.user.id } })).toBe(1);
    expect((await f.request(token)).json()).toMatchObject({ sub: f.user.id, email: f.user.email });
    expect((await f.request(token, '/oauth/me')).statusCode).toBe(404);
    const connected = await f.connect(token); expect(connected.statusCode, connected.body).toBe(200);
    const ticket = connected.json().connection_ticket;
    expect(decodeJwt(ticket)).toMatchObject({ token_use: 'embedded_kelpie_connect', scope: 'kelpie.connect', aud: f.resource, assurance_id: f.proof.assurance.id });
    const validated = await f.validate(ticket); expect(validated.statusCode, validated.body).toBe(200);
    expect(validated.json()).toMatchObject({ active: true, source: 'embedded', sub: f.user.id, app_id: `embedded:${f.domain}` });
    expect((await f.request(ticket)).statusCode).toBe(401);
    expect((await f.validate(token)).statusCode).toBe(401);
    expect((await f.connect(ticket)).statusCode).toBe(401);
  });
  it('refuses settings outside browser bookmarks over HTTP and WebSocket', async () => {
    const f = await fixture(); const token = await f.session();
    await f.db.userSetting.create({ data: { userId: f.user.id, namespace: 'private-product', key: 'private-preference', value: 'owned elsewhere' } });
    for (const path of ['private-product/private-preference', 'browser/other-setting']) {
      const url = '/embedded/kelpie/me/settings/' + path;
      const refused = await f.request(token, url);
      expect(refused.statusCode).toBe(403); expect(refused.headers['cache-control']).toContain('no-store');
      const put = await f.app.inject({ method: 'PUT', url, headers: { authorization: 'Bearer ' + token }, payload: { value: 'not allowed' } });
      expect(put.statusCode).toBe(403);
    }
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const handshake = await new Promise<{ status: number; cache: unknown }>((resolve, reject) => {
      const socket = new WebSocket(address.replace('http:', 'ws:') + '/embedded/kelpie/me/settings/private-product/private-preference/events',
        { headers: { authorization: 'Bearer ' + token }, handshakeTimeout: 3000 });
      socket.once('open', () => { socket.close(); reject(new Error('Unrelated setting stream was admitted')); });
      socket.once('error', reject);
      socket.once('unexpected-response', (_request, response) => {
        response.resume(); resolve({ status: response.statusCode ?? 0, cache: response.headers['cache-control'] }); socket.terminate();
      });
    });
    expect(handshake.status).toBe(403); expect(handshake.cache).toContain('no-store');
    expect(await f.db.userSetting.findUnique({ where: { userId_namespace_key: {
      userId: f.user.id, namespace: 'private-product', key: 'private-preference',
    } } })).toMatchObject({ value: 'owned elsewhere' });
  });
  it('uses the authoritative bookmark store and preserves compare-and-swap conflicts', async () => {
    const f = await fixture(); const token = await f.session(); const url = '/embedded/kelpie/me/settings/browser/bookmarks';
    const initial = await f.request(token, url); expect(initial.statusCode).toBe(200); expect(initial.json()).toEqual({ value: null });
    const write = (version: string, value: unknown) => f.app.inject({ method: 'PUT', url,
      headers: { authorization: `Bearer ${token}`, 'if-match': version }, payload: { value } });
    const value = [{ url: 'https://example.com', name: 'Example' }];
    const updated = await write(String(initial.headers.etag), value); expect(updated.statusCode, updated.body).toBe(200);
    expect((await write(String(initial.headers.etag), [])).statusCode).toBe(409);
    expect((await f.request(token, url)).json()).toEqual({ value });
    expect(await f.db.userSetting.findUnique({ where: { userId_namespace_key: { userId: f.user.id, namespace: 'browser', key: 'bookmarks' } } }))
      .toMatchObject({ value });
  });
  it.each(['proof', 'family', 'epoch', 'person', 'domain', 'role', 'team', 'factor'] as const)(
    'refuses %s revocation on both account requests and existing gateway tickets', async reason => {
      const f = await fixture(); const token = await f.session();
      const connected = await f.connect(token); expect(connected.statusCode).toBe(200);
      const ticket = connected.json().connection_ticket;
      if (reason === 'proof') await f.db.sessionAssurance.update({ where: { id: f.proof.assurance.id }, data: { revokedAt: new Date() } });
      if (reason === 'family') await f.db.refreshToken.updateMany({ where: { familyId: f.familyId }, data: { revokedAt: new Date() } });
      if (reason === 'epoch') await f.db.user.update({ where: { id: f.user.id }, data: { tokenVersion: 1 } });
      if (reason === 'person') await f.db.user.update({ where: { id: f.user.id }, data: { lifecycleStatus: 'DISABLED' } });
      if (reason === 'domain') await f.db.clientDomain.update({ where: { id: f.client.id }, data: { status: 'disabled' } });
      if (reason === 'role') await f.db.domainRole.delete({ where: { domain_userId: { domain: f.domain, userId: f.user.id } } });
      if (reason === 'team') await f.db.teamMember.update({ where: { teamId_userId: { teamId: f.team.id, userId: f.user.id } }, data: { status: 'REMOVED' } });
      if (reason === 'factor') await f.db.user.update({ where: { id: f.user.id }, data: { twoFaEnabled: true } });
      expect((await f.request(token)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await f.validate(ticket)).statusCode).toBeGreaterThanOrEqual(400);
    });

  it('streams committed host bookmarks and closes on original-proof revocation before another value', async () => {
    const f = await fixture(); const token = await f.session();
    const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const url = '/embedded/kelpie/me/settings/browser/bookmarks';
    const socket = new WebSocket(address.replace('http:', 'ws:') + url + '/events',
      { headers: { authorization: `Bearer ${token}` } });
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      await expect.poll(() => frames.length).toBe(1);
      expect(frames[0]).toMatchObject({ type: 'settings.snapshot', protocolVersion: 1, value: null });
      const initial = await f.request(token, url);
      const saved = await f.app.inject({ method: 'PUT', url,
        headers: { authorization: `Bearer ${token}`, 'if-match': String(initial.headers.etag) },
        payload: { value: [{ url: 'https://example.com', name: 'Example' }] } });
      expect(saved.statusCode).toBe(200);
      await expect.poll(() => frames.length).toBe(2);
      expect(frames[1]).toMatchObject({ type: 'settings.delta', baseVersion: frames[0]!.version, version: saved.headers.etag });
      const closed = new Promise<number>(resolve => socket.once('close', resolve));
      await f.db.sessionAssurance.update({ where: { id: f.proof.assurance.id }, data: { revokedAt: new Date() } });
      await f.db.userSetting.deleteMany({ where: { userId: f.user.id, namespace: 'browser' } });
      expect(await closed).toBe(1008);
      expect(frames).toHaveLength(2);
    } finally { socket.terminate(); await f.app.close(); apps.splice(apps.indexOf(f.app), 1); }
  });
  it('refuses missing proof and scope/epoch substitution before grant issue', async () => {
    const f = await fixture();
    for (const extra of [{ assurance_ref: undefined }, { tv: 1 }, { active: { orgId: f.org.id, teamId: 'foreign' } }]) {
      const result = await f.grant(extra); expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.json()).toEqual({ error: 'Request failed' });
    }
    expect((await f.grant({}, 'wrong-backend')).statusCode).toBe(401);
  });
});
