import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORG_SUBJECT_ASSERTION_AUDIENCE } from '../../src/middleware/org-role-guard.js';
import { createProfileDirectoryFixture, profileDirectoryDomain as domain, profileDirectoryQuery as query } from '../helpers/profile-directory-fixture.js';
import { baseClientConfigPayload, createTestConfigFetchHandler, signTestConfigJwt, testConfigJwks } from '../helpers/test-config.js';
import { socketRequest } from '../helpers/http-socket.js';

describe.skipIf(!process.env.DATABASE_URL)('profile/directory TCP HTTP with real PostgreSQL roles', () => {
  let suite: Awaited<ReturnType<typeof createProfileDirectoryFixture>>;
  let base: string, retain = false;
  beforeAll(async () => {
    suite = await createProfileDirectoryFixture();
    const role = await suite.appDb.$queryRaw<Array<{ role: string; bypass: boolean }>>`
      SELECT current_user AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual([{ role: 'uoa_app', bypass: false }]);
    const jwksUrl = `https://${domain}/subject-jwks`;
    const config = await signTestConfigJwt(baseClientConfigPayload({ domain, jwks_url: jwksUrl,
      org_features: { enabled: true, groups_enabled: true }, login_flow: { team_selection: 'off' } }));
    const fallback = await createTestConfigFetchHandler(config), jwks = await testConfigJwks();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url === jwksUrl ? Promise.resolve(new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } })) : fallback(input);
    }));
    base = await suite.app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(({ task }) => { if (task.result?.state === 'fail') retain = true; });
  afterAll(async () => { await suite?.close(retain); });
  async function assertion(f: Awaited<ReturnType<typeof suite.subject>>) {
    const now = Math.floor(Date.now() / 1000);
    const token = await signTestConfigJwt({ iss: domain, source_domain: domain, sub: f.owner.id,
      tv: 0, jti: randomUUID(), iat: now, exp: now + 60, active: { orgId: f.org.id, teamId: f.team.id } },
    { audience: ORG_SUBJECT_ASSERTION_AUDIENCE });
    return { authorization: f.headers.authorization, 'x-uoa-subject-assertion': token };
  }

  it('reads and patches canonical self using actual RS256 subject assertions over TCP', async () => {
    const f = await suite.subject(), headers = await assertion(f);
    const count = await suite.db.user.count();
    const read = await socketRequest(base, '/profile/me' + query, { headers });
    expect(read.status).toBe(200);
    expect(read.json()).toMatchObject({ id: f.owner.id, email: f.owner.email, name: 'Canonical Owner' });
    const changed = await socketRequest(base, '/profile/me' + query, { method: 'PATCH', headers,
      json: { name: 'TCP Canonical', pronouns_preset: 'custom', pronouns_custom: 'xe/xem' } });
    expect(changed.status).toBe(200);
    expect(changed.headers['cache-control']).toBe('private, no-store');
    expect(changed.json()).toMatchObject({ id: f.owner.id, email: f.owner.email, name: 'TCP Canonical', pronouns_display: 'xe/xem' });
    expect(await suite.db.user.count()).toBe(count);
    expect(await suite.db.directoryChangeOutbox.findMany({ where: { orgId: f.org.id }, select: { kind: true, revision: true, subjectId: true } }))
      .toEqual([{ kind: 'profile.changed', revision: 1n, subjectId: f.owner.id }]);
    const forbidden = await socketRequest(base, '/profile/me' + query, { method: 'PATCH', headers, json: { email: 'other@example.com' } });
    expect(forbidden.status).toBe(400);
  });

  it('uploads raster bytes and serves the exact authenticated no-store avatar over TCP', async () => {
    const f = await suite.subject();
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 0x21)]);
    const boundary = 'uoa-audit-avatar';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const uploaded = await socketRequest(base, `/avatar/me?domain=${domain}`, { method: 'PUT',
      headers: { ...f.headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    expect(uploaded.status).toBe(200);
    const avatar = await socketRequest(base, '/profile/me/avatar' + query, { headers: await assertion(f) });
    expect(avatar.status).toBe(200);
    expect(avatar.body.equals(bytes)).toBe(true);
    expect(avatar.headers['content-type']).toContain('image/png');
    expect(avatar.headers['cache-control']).toBe('private, no-store');
    expect(avatar.headers['x-content-type-options']).toBe('nosniff');
    const anonymous = await socketRequest(base, '/profile/me/avatar' + query, { headers: { authorization: f.headers.authorization } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('private, no-store');
  });

  it('preserves nullable ACTIVE display and exact historical provenance over TCP', async () => {
    const f = await suite.subject(), headers = await assertion(f);
    const path = `/org/organisations/${f.org.id}/users/${f.target.id}/display`;
    await suite.db.user.update({ where: { id: f.target.id }, data: { name: null } });
    expect((await socketRequest(base, path + query, { headers })).json()).toMatchObject({ id: f.target.id, name: null, deleted: false });
    await suite.db.orgMember.delete({ where: { orgId_userId: { orgId: f.org.id, userId: f.target.id } } });
    await suite.db.user.update({ where: { id: f.target.id }, data: { lifecycleStatus: 'DELETED', email: null, userKey: null, name: null } });
    expect((await socketRequest(base, path + query, { headers })).status).toBe(404);
    await suite.db.historicalOrganisationIdentityReference.create({ data: { userId: f.target.id, orgId: f.org.id } });
    expect((await socketRequest(base, path + query, { headers })).json()).toEqual({ id: f.target.id, name: 'Deleted user', deleted: true });
    expect((await socketRequest(base, path + '/avatar' + query, { headers })).status).toBe(404);
    await suite.db.user.delete({ where: { id: f.target.id } });
    expect((await socketRequest(base, path + query, { headers })).status).toBe(404);
  });

  it('refuses an expired user token after an observed PostgreSQL lock wait over TCP', async () => {
    const f = await suite.subject(), blocker = await suite.holdUser(f.owner.id);
    const token = await f.token('2s');
    const pending = socketRequest(base, '/profile/me' + query, { method: 'PATCH',
      headers: { ...f.headers, 'x-uoa-access-token': token }, json: { name: 'Expired TCP write' } });
    try {
      await suite.waitForBlocked(blocker.pid);
      const wait = decodeJwt(token).exp! * 1000 - Date.now() + 50;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    } finally { await blocker.release(); }
    expect((await pending).status).toBe(401);
    expect((await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).name).toBe('Canonical Owner');
    expect(await suite.db.directoryChangeOutbox.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  it('uses the supported operator/owner doorway and expires directory authority after a TCP lock wait', async () => {
    const f = await suite.subject();
    const issued = await socketRequest(base, '/internal/admin/directory-credentials', { method: 'POST',
      headers: { authorization: `Bearer ${suite.adminToken}` }, json: { client_domain_id: suite.domain.id,
        label: 'TCP authority proof', expires_at: new Date(Date.now() + 120_000).toISOString() } });
    expect(issued.status).toBe(201);
    const credential = issued.json<{ id: string; secret: string }>();
    const granted = await socketRequest(base, `/org/organisations/${f.org.id}/product-access/${credential.id}${query}`, {
      method: 'PUT', headers: f.headers, json: { permissions: ['MEMBERSHIP_READ'] } });
    expect(granted.status).toBe(200);
    const headers = { authorization: `Bearer ${credential.secret}` };
    const path = `/directory/v1/organisations/${f.org.id}/subjects/${f.owner.id}`;
    const read = await socketRequest(base, path + '/standing', { headers });
    expect(read.status).toBe(200);
    expect(read.json()).toMatchObject({ subject: f.owner.id, organisation_id: f.org.id, active: true, credential_epoch: 0 });
    expect((await socketRequest(base, path + '/display', { headers })).status).toBe(403);
    const expiresAt = new Date(Date.now() + 2000);
    await suite.db.directoryCredentialSecret.updateMany({ where: { credentialId: credential.id }, data: { expiresAt } });
    const blocker = await suite.holdUser(f.owner.id);
    const pending = socketRequest(base, path + '/standing', { headers });
    try {
      await suite.waitForBlocked(blocker.pid);
      const wait = expiresAt.getTime() - Date.now() + 50;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    } finally { await blocker.release(); }
    expect((await pending).status).toBe(401);
  });

  it('keeps a real authority-store outage generic and no-store over TCP', async () => {
    const f = await suite.subject();
    await suite.db.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA "${suite.handle.schema}" FROM uoa_admin`);
    try {
      const response = await socketRequest(base, '/profile/me' + query, { headers: f.headers });
      expect(response.status).toBe(500);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body.toString().includes(f.owner.email!)).toBe(false);
    } finally { await suite.db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${suite.handle.schema}" TO uoa_admin`); }
  });
});
