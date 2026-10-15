import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asPrismaClient, runWithTenantContext } from '../../src/db/tenant-context.js';
import { getAdminPrisma } from '../../src/db/prisma.js';
import { addGroupMember, createGroup } from '../../src/services/group.service.js';
import { removeOrganisationMember } from '../../src/services/organisation.service.members.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { revokeAllRefreshTokensForUser } from '../../src/services/refresh-token-revocation.service.js';
import { createProfileDirectoryFixture, profileDirectoryDomain as domain, profileDirectoryQuery as query } from '../helpers/profile-directory-fixture.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { socketRequest } from '../helpers/http-socket.js';

const config = validateConfigFields(baseClientConfigPayload({ domain,
  org_features: { enabled: true, groups_enabled: true }, login_flow: { team_selection: 'off' } }));
function latch() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

describe.skipIf(!process.env.DATABASE_URL)('canonical writer families on PostgreSQL/TCP/RLS', () => {
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
  const admin = () => ({ authorization: `Bearer ${suite.adminToken}` });
  const changes = (orgId: string) => suite.db.directoryChangeOutbox.findMany({ where: { orgId }, orderBy: { revision: 'asc' },
    select: { revision: true, kind: true, subjectId: true, teamId: true } });
  async function group(orgId: string) {
    const response = await socketRequest(base, `/internal/org/organisations/${orgId}/groups${query}`, {
      method: 'POST', headers: admin(), json: { name: 'Runtime group' } });
    expect(response.status).toBe(200);
    return response.json<{ id: string }>().id;
  }

  it('invalidates every current organisation for global profile/avatar/credential-epoch writes', async () => {
    const f = await suite.subject();
    const second = await suite.db.organisation.create({ data: { domain, name: 'Membership-only scope', slug: randomUUID(), ownerId: f.target.id } });
    await suite.db.orgMember.createMany({ data: [
      { orgId: second.id, userId: f.owner.id, role: 'member' }, { orgId: second.id, userId: f.target.id, role: 'owner' },
    ] });
    // Legacy owner references can survive without an OrgMember row. Both scope
    // sources must participate, with the first org deduplicated across them.
    const third = await suite.db.organisation.create({ data: { domain, name: 'Ownership-only scope', slug: randomUUID(), ownerId: f.owner.id } });
    const patched = await socketRequest(base, '/profile/me' + query, { method: 'PATCH', headers: f.headers, json: { name: 'Global profile' } });
    expect(patched.status).toBe(200);
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 0x21)]);
    const boundary = 'uoa-writer-avatar';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    expect((await socketRequest(base, `/avatar/me?domain=${domain}`, { method: 'PUT',
      headers: { ...f.headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, body })).status).toBe(200);
    expect((await socketRequest(base, `/avatar/me?domain=${domain}`, { method: 'DELETE', headers: f.headers })).status).toBe(200);
    await revokeAllRefreshTokensForUser(f.owner.id);
    expect((await suite.db.user.findUniqueOrThrow({ where: { id: f.owner.id } })).tokenVersion).toBe(1);
    for (const orgId of [f.org.id, second.id, third.id]) {
      expect(await changes(orgId)).toEqual([
        { revision: 1n, kind: 'profile.changed', subjectId: f.owner.id, teamId: null },
        { revision: 2n, kind: 'profile.changed', subjectId: f.owner.id, teamId: null },
        { revision: 3n, kind: 'profile.changed', subjectId: f.owner.id, teamId: null },
        { revision: 4n, kind: 'credential_epoch.changed', subjectId: f.owner.id, teamId: null },
      ]);
    }
    expect((await socketRequest(base, '/profile/me' + query, { headers: f.headers })).status).toBe(401);
  });

  it('commits each group/member/team-assignment write with its ordered outbox event through uoa_app', async () => {
    const f = await suite.subject();
    await suite.db.team.update({ where: { id: f.team.id }, data: { joinPolicy: 'OPEN_TO_ORG', iconUrl: 'https://media.example.com/team.png' } });
    const id = await group(f.org.id);
    const path = `/internal/org/organisations/${f.org.id}/groups/${id}`;
    expect((await socketRequest(base, path + query, { method: 'PUT', headers: admin(), json: { name: 'Updated group' } })).status).toBe(200);
    expect((await socketRequest(base, path + '/members' + query, { method: 'POST', headers: admin(), json: { userId: f.target.id, isAdmin: false } })).status).toBe(200);
    expect((await socketRequest(base, path + `/members/${f.target.id}` + query, { method: 'PUT', headers: admin(), json: { isAdmin: true } })).status).toBe(200);
    const assigned = await socketRequest(base, `/internal/org/organisations/${f.org.id}/teams/${f.team.id}/group${query}`, {
      method: 'PUT', headers: admin(), json: { groupId: id } });
    expect(assigned.status).toBe(200);
    expect(assigned.json()).toMatchObject({ groupId: id, joinPolicy: 'OPEN_TO_ORG', iconUrl: 'https://media.example.com/team.png' });
    expect((await socketRequest(base, path + `/members/${f.target.id}` + query, { method: 'DELETE', headers: admin() })).status).toBe(200);
    expect((await socketRequest(base, path + query, { method: 'DELETE', headers: admin() })).status).toBe(200);
    expect(await changes(f.org.id)).toEqual([
      { revision: 1n, kind: 'organisation.changed', subjectId: null, teamId: null },
      { revision: 2n, kind: 'organisation.changed', subjectId: null, teamId: null },
      { revision: 3n, kind: 'membership.changed', subjectId: f.target.id, teamId: null },
      { revision: 4n, kind: 'membership.changed', subjectId: f.target.id, teamId: null },
      { revision: 5n, kind: 'team.changed', subjectId: null, teamId: f.team.id },
      { revision: 6n, kind: 'membership.changed', subjectId: f.target.id, teamId: null },
      { revision: 7n, kind: 'organisation.changed', subjectId: null, teamId: null },
    ]);
    expect(await suite.db.group.count({ where: { orgId: f.org.id } })).toBe(0);
    expect((await suite.db.team.findUniqueOrThrow({ where: { id: f.team.id } })).groupId).toBeNull();
  });

  it('rolls back actual group creation, allocated revision and event together under tenant RLS', async () => {
    const f = await suite.subject();
    await expect(runWithTenantContext({ context: { domain, orgId: f.org.id, userId: f.owner.id }, prisma: suite.appDb }, async tx => {
      await createGroup({ orgId: f.org.id, domain, name: 'Rollback', config }, { prisma: asPrismaClient(tx) });
      throw new Error('Forced writer rollback');
    })).rejects.toThrow('Forced writer rollback');
    expect(await suite.db.group.count({ where: { orgId: f.org.id } })).toBe(0);
    expect(await changes(f.org.id)).toEqual([]);
    expect(await suite.db.directoryOrganisationRevision.findUnique({ where: { orgId: f.org.id } })).toBeNull();
  });

  it('rechecks removed membership after an observed canonical user-lock wait before group insertion', async () => {
    const f = await suite.subject(), id = await group(f.org.id);
    const entered = latch(), release = latch();
    let pid = 0;
    const removal = getAdminPrisma().$transaction(async tx => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await removeOrganisationMember({ orgId: f.org.id, domain, userId: f.target.id,
        actor: { via: 'domain_backend', sourceDomain: domain }, config }, {
        prisma: asPrismaClient(tx), afterMembershipStatusWrite: async () => { entered.open(); await release.promise; },
      });
    }, { timeout: 15_000 });
    await entered.promise;
    const pending = runWithTenantContext({ context: { domain, orgId: f.org.id, userId: decodeJwt(suite.adminToken).sub }, prisma: suite.appDb }, tx =>
      addGroupMember({ orgId: f.org.id, groupId: id, domain, userId: f.target.id, config }, { prisma: asPrismaClient(tx) }));
    const outcome = pending.then(() => ({ committed: true }), error => ({ error }));
    try { await suite.waitForBlocked(pid); } finally { release.open(); await removal; }
    expect(await outcome).toMatchObject({ error: { statusCode: 400 } });
    expect(await suite.db.groupMember.count({ where: { groupId: id, userId: f.target.id } })).toBe(0);
    expect((await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.org.id, userId: f.target.id } } })).status).toBe('REMOVED');
    expect((await changes(f.org.id)).map(change => change.kind)).toEqual(['organisation.changed', 'membership.changed']);
  });

  it('resolves a cross-origin subject and keeps guard permission outages as generic failures', async () => {
    const f = await suite.subject(), id = await group(f.org.id);
    await suite.db.user.update({ where: { id: f.target.id }, data: { domain: 'other-origin.example.com' } });
    const path = `/internal/org/organisations/${f.org.id}/groups/${id}/members`;
    const added = await socketRequest(base, path + query, { method: 'POST', headers: admin(), json: { userId: f.target.id } });
    expect(added.status).toBe(200);
    const cursor = await changes(f.org.id);
    await suite.db.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION "${suite.handle.schema}".uoa_group_membership_admission(text,text) FROM uoa_app`);
    try {
      const failed = await socketRequest(base, path + `/${f.target.id}` + query, { method: 'PUT', headers: admin(), json: { isAdmin: true } });
      expect(failed.status).toBe(500);
      expect(await changes(f.org.id)).toEqual(cursor);
      expect((await suite.db.groupMember.findUniqueOrThrow({ where: { groupId_userId: { groupId: id, userId: f.target.id } } })).isAdmin).toBe(false);
    } finally {
      await suite.db.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION "${suite.handle.schema}".uoa_group_membership_admission(text,text) TO uoa_app`);
    }
  });

  it('does not let the definer admission check escape missing or sibling tenant context', async () => {
    const f = await suite.subject(), sibling = await suite.subject();
    expect(await suite.appDb.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT uoa_group_membership_admission(${f.org.id},${f.target.id}) AS allowed`)
      .toEqual([{ allowed: false }]);
    await runWithTenantContext({ context: { domain, orgId: f.org.id, userId: f.owner.id }, prisma: suite.appDb }, async tx => {
      expect(await tx.$queryRaw<Array<{ allowed: boolean }>>`
        SELECT uoa_group_membership_admission(${f.org.id},${f.target.id}) AS allowed`)
        .toEqual([{ allowed: true }]);
      expect(await tx.$queryRaw<Array<{ allowed: boolean }>>`
        SELECT uoa_group_membership_admission(${sibling.org.id},${sibling.target.id}) AS allowed`)
        .toEqual([{ allowed: false }]);
    });
  });

  it('freezes group admission for deleting subjects, including an older raw writer', async () => {
    const f = await suite.subject();
    await suite.db.user.update({ where: { id: f.target.id }, data: { lifecycleStatus: 'DELETING' } });
    const id = await group(f.org.id);
    expect((await socketRequest(base, `/internal/org/organisations/${f.org.id}/groups/${id}/members${query}`, {
      method: 'POST', headers: admin(), json: { userId: f.target.id } })).status).toBe(400);
    await expect(suite.db.groupMember.create({ data: { groupId: id, userId: f.target.id } }))
      .rejects.toMatchObject({ code: 'P2003' });
    expect((await changes(f.org.id)).map(change => change.kind)).toEqual(['organisation.changed']);
    expect(await suite.db.groupMember.count({ where: { groupId: id } })).toBe(0);
  });
});
