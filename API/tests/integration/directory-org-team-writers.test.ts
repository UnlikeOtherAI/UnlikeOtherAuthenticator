import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/services/token-signing.service.js';
import { createProfileDirectoryFixture, profileDirectoryDomain as domain, profileDirectoryQuery as query } from '../helpers/profile-directory-fixture.js';
import { socketRequest } from '../helpers/http-socket.js';

describe.skipIf(!process.env.DATABASE_URL)('organisation/team canonical writers over TCP and tenant RLS', () => {
  let suite: Awaited<ReturnType<typeof createProfileDirectoryFixture>>;
  let base: string, retain = false;
  beforeAll(async () => {
    suite = await createProfileDirectoryFixture();
    expect(await suite.appDb.$queryRaw<Array<{ role: string; bypass: boolean }>>`
      SELECT current_user AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`)
      .toEqual([{ role: 'uoa_app', bypass: false }]);
    base = await suite.app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(({ task }) => { if (task.result?.state === 'fail') retain = true; });
  afterAll(async () => { await suite?.close(retain); });
  const backend = () => ({ authorization: `Bearer ${suite.domainHash}` });
  const admin = () => ({ authorization: `Bearer ${suite.adminToken}` });
  async function call(path: string, method: string, headers: Record<string, string>, json?: unknown) {
    const response = await socketRequest(base, path + query, { method, headers, json });
    expect(response.status, `${method} ${path}: HTTP ${response.status}`).toBe(200);
    return response;
  }
  async function events(orgId: string) {
    const rows = await suite.db.directoryChangeOutbox.findMany({ where: { orgId }, orderBy: { revision: 'asc' },
      select: { revision: true, kind: true, subjectId: true, teamId: true } });
    expect(rows.map(row => row.revision)).toEqual(rows.map((_, index) => BigInt(index + 1)));
    expect((await suite.db.directoryOrganisationRevision.findUniqueOrThrow({ where: { orgId } })).revision).toBe(BigInt(rows.length));
    return rows;
  }
  async function targetHeaders(f: Awaited<ReturnType<typeof suite.subject>>) {
    const token = await signAccessToken({ userId: f.target.id, email: f.target.email!, domain,
      clientId: suite.domain.id, role: 'user', tokenVersion: 0, ttl: '30m', sharedSecret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!, relyingPartyToken: true,
      org: { org_id: f.org.id, org_role: 'member', teams: [f.team.id], team_roles: { [f.team.id]: 'member' } } });
    return { ...backend(), 'x-uoa-access-token': token };
  }

  it('creates one canonical org/default-team/owner membership set and publishes its update', async () => {
    const f = await suite.subject();
    expect((await socketRequest(base, '/org/organisations' + query, { method: 'POST', headers: f.headers,
      json: { name: 'Disallowed self provisioning' } })).status).toBe(403);
    const created = (await call('/org/organisations', 'POST', backend(), {
      name: 'Backend authority', owner_user_id: f.owner.id,
    })).json<{ id: string; defaultTeam: { id: string } }>();
    await call(`/org/organisations/${created.id}`, 'PUT', backend(), { name: 'Renamed authority' });
    expect(await suite.db.orgMember.findMany({ where: { orgId: created.id }, select: { userId: true, role: true, status: true } }))
      .toEqual([{ userId: f.owner.id, role: 'owner', status: 'ACTIVE' }]);
    expect(await suite.db.teamMember.findMany({ where: { teamId: created.defaultTeam.id }, select: { userId: true, teamRole: true } }))
      .toEqual([{ userId: f.owner.id, teamRole: 'owner' }]);
    expect((await events(created.id)).map(row => [row.kind, row.subjectId, row.teamId]))
      .toEqual([['organisation.changed', null, null], ['organisation.changed', null, null]]);
    expect((await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).name).toBe('Canonical Owner');
  });

  it('publishes new, removed and re-added org memberships including both default-team branches', async () => {
    const f = await suite.subject(), path = `/org/organisations/${f.org.id}/members`;
    const fresh = await suite.db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    await call(path, 'POST', f.headers, { userId: fresh.id });
    const original = await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.org.id, userId: fresh.id } } });
    await call(`${path}/${fresh.id}`, 'PUT', f.headers, { role: 'admin' });
    const group = await suite.db.group.create({ data: { orgId: f.org.id, name: 'Membership cleanup', slug: randomUUID() } });
    await suite.db.groupMember.create({ data: { groupId: group.id, userId: fresh.id } });
    await call(`${path}/${fresh.id}`, 'DELETE', f.headers);
    expect(await suite.db.groupMember.count({ where: { groupId: group.id, userId: fresh.id } })).toBe(0);
    await call(path, 'POST', f.headers, { userId: fresh.id, role: 'member' });
    expect(await suite.db.orgMember.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ status: 'ACTIVE', role: 'member' });
    // An older removed org member may never have had a default-team row.
    const legacy = await suite.db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    await suite.db.orgMember.create({ data: { orgId: f.org.id, userId: legacy.id, status: 'REMOVED' } });
    await call(path, 'POST', f.headers, { userId: legacy.id });
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: f.team.id, userId: legacy.id } } }))
      .toMatchObject({ status: 'ACTIVE', teamRole: 'member' });
    expect((await events(f.org.id)).map(row => [row.kind, row.subjectId, row.teamId]))
      .toEqual([fresh.id, fresh.id, fresh.id, fresh.id, legacy.id].map(id => ['membership.changed', id, null]));
  });

  it('publishes team CRUD, role changes, removal, deactivation and status-only restoration', async () => {
    const f = await suite.subject(), org = `/org/organisations/${f.org.id}`;
    const team = (await call(org + '/teams', 'POST', f.headers, { name: 'Writer team', join_creator: true })).json<{ id: string }>();
    const path = `${org}/teams/${team.id}`;
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team.id, userId: f.owner.id } } }))
      .toMatchObject({ status: 'ACTIVE', teamRole: 'owner' });
    await call(path, 'PUT', f.headers, { name: 'Updated team', joinPolicy: 'OPEN_TO_ORG', icon_url: 'https://media.example.com/team.png' });
    await call(path + '/members', 'POST', f.headers, { userId: f.target.id });
    await call(path + `/members/${f.target.id}`, 'PUT', f.headers, { teamRole: 'admin' });
    await call(path + `/members/${f.target.id}`, 'DELETE', f.headers);
    await call(`${org}/members/${f.target.id}/deactivate`, 'POST', f.headers);
    await call(`${org}/members/${f.target.id}/reactivate`, 'POST', f.headers);
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team.id, userId: f.target.id } } }))
      .toMatchObject({ status: 'REMOVED', teamRole: 'admin' });
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: f.team.id, userId: f.target.id } } }))
      .toMatchObject({ status: 'ACTIVE', teamRole: 'member' });
    await call(path + '/members', 'POST', f.headers, { userId: f.target.id, teamRole: 'member' });
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team.id, userId: f.target.id } } }))
      .toMatchObject({ status: 'ACTIVE', teamRole: 'member' });
    expect((await events(f.org.id)).map(row => [row.kind, row.subjectId, row.teamId])).toEqual([
      ['team.changed', null, null], ['team.changed', null, team.id],
      ...Array.from({ length: 3 }, () => ['membership.changed', f.target.id, team.id]),
      ['membership.changed', f.target.id, null], ['membership.changed', f.target.id, null],
      ['membership.changed', f.target.id, team.id],
    ]);
  });

  it('self-joins a fresh and removed team seat with the configured default role', async () => {
    const f = await suite.subject(), headers = await targetHeaders(f);
    const team = await suite.db.team.create({ data: { orgId: f.org.id, name: 'Open', slug: randomUUID(), joinPolicy: 'OPEN_TO_ORG' } });
    const path = `/org/organisations/${f.org.id}/teams/${team.id}`;
    await call(path + '/join', 'POST', headers);
    const first = await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team.id, userId: f.target.id } } });
    await call(path + `/members/${f.target.id}`, 'PUT', f.headers, { teamRole: 'admin' });
    await call(path + `/members/${f.target.id}`, 'DELETE', f.headers);
    await call(path + '/join', 'POST', headers);
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'ACTIVE', teamRole: 'member' });
    expect((await events(f.org.id)).map(row => [row.kind, row.subjectId, row.teamId]))
      .toEqual(Array.from({ length: 4 }, () => ['membership.changed', f.target.id, team.id]));
  });

  it('transfers canonical ownership and immediately refuses the prior owner grant authority', async () => {
    const f = await suite.subject(), credential = await suite.directory(f);
    const path = `/org/organisations/${f.org.id}`;
    await call(path + '/transfer-ownership', 'POST', f.headers, { newOwnerId: f.target.id, previousOwnerRole: 'member' });
    expect((await suite.db.organisation.findUniqueOrThrow({ where: { id: f.org.id } })).ownerId).toBe(f.target.id);
    expect((await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.org.id, userId: f.owner.id } } })).role).toBe('member');
    expect((await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.org.id, userId: f.target.id } } })).role).toBe('owner');
    expect((await socketRequest(base, `/directory/v1/organisations/${f.org.id}/subjects/${f.owner.id}/standing`, { headers: credential.headers })).status).toBe(403);
    expect((await socketRequest(base, path + `/product-access/${credential.id}` + query, {
      method: 'PUT', headers: f.headers, json: { permissions: ['MEMBERSHIP_READ'] } })).status).toBe(403);
    expect((await events(f.org.id)).map(row => [row.kind, row.subjectId, row.teamId])).toEqual([['organisation.changed', null, null]]);
  });

  it('publishes operator org/team provisioning and AddUserToTeam create/update upserts', async () => {
    const f = await suite.subject();
    const created = await socketRequest(base, '/internal/admin/organisations', { method: 'POST', headers: admin(),
      json: { name: 'Operator authority', domain, owner_email: f.owner.email } });
    expect(created.status).toBe(200);
    const orgId = created.json<{ id: string }>().id;
    const team = await suite.db.team.findFirstOrThrow({ where: { orgId, isDefault: true } });
    expect((await socketRequest(base, `/internal/admin/organisations/${orgId}`, { method: 'PATCH', headers: admin(),
      json: { allowed_email_domains: ['example.com'], twoFaPolicy: 'optional' } })).status).toBe(200);
    expect((await socketRequest(base, `/internal/admin/organisations/${orgId}/teams/${team.id}`, { method: 'PATCH', headers: admin(),
      json: { name: 'Operator updated team' } })).status).toBe(200);
    const add = () => socketRequest(base, `/internal/admin/users/${f.target.id}/teams`, { method: 'POST', headers: admin(),
      json: { orgId, teamId: team.id, teamRole: 'member' } });
    expect((await add()).status).toBe(200);
    const member = await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId, userId: f.target.id } } });
    await call(`/org/organisations/${orgId}/members/${f.target.id}`, 'DELETE', backend());
    expect((await add()).status).toBe(200);
    expect(await suite.db.orgMember.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ status: 'ACTIVE', role: 'member' });
    expect((await events(orgId)).map(row => row.kind)).toEqual([
      'organisation.changed', 'organisation.changed', 'team.changed', 'membership.changed', 'membership.changed', 'membership.changed',
    ]);
  });
});
