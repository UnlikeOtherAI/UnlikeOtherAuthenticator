import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAdminPrisma } from '../../src/db/prisma.js';
import { runInTransaction } from '../../src/db/tenant-context.js';
import { acceptTeamInviteWithinTransaction } from '../../src/services/team-invite.service.acceptance.js';
import { redeemTeamInviteLink } from '../../src/services/team-invite-link.redemption.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { hashEmailToken } from '../../src/utils/verification-token.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createProfileDirectoryFixture, profileDirectoryDomain as domain, profileDirectoryQuery as query } from '../helpers/profile-directory-fixture.js';
import { socketRequest } from '../helpers/http-socket.js';

describe.skipIf(!process.env.DATABASE_URL)('admission and team-avatar directory writers on PostgreSQL', () => {
  let suite: Awaited<ReturnType<typeof createProfileDirectoryFixture>>;
  let base: string, retain = false;
  beforeAll(async () => {
    suite = await createProfileDirectoryFixture();
    expect((await getAdminPrisma().$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`)[0].role).toBe('uoa_admin');
    base = await suite.app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(({ task }) => { if (task.result?.state === 'fail') retain = true; });
  afterAll(async () => { await suite?.close(retain); });
  const config = (limits: Record<string, number> = {}) => validateConfigFields(baseClientConfigPayload({ domain,
    org_features: { enabled: true, groups_enabled: true, ...limits } }));
  const user = () => suite.db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
  async function events(orgId: string) {
    const rows = await suite.db.directoryChangeOutbox.findMany({ where: { orgId }, orderBy: { revision: 'asc' },
      select: { revision: true, kind: true, subjectId: true, teamId: true } });
    expect(rows.map(row => row.revision)).toEqual(rows.map((_, index) => BigInt(index + 1)));
    return rows;
  }
  async function invite(f: Awaited<ReturnType<typeof suite.subject>>, subject: { id: string; email: string | null }) {
    return suite.db.teamInvite.create({ data: { orgId: f.org.id, teamId: f.team.id, email: subject.email!,
      teamRole: 'member', inviteName: 'Invited canonical name', invitedByUserId: f.owner.id,
      lastSentAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
  }
  async function accept(id: string, userId: string, rollback = false) {
    return runInTransaction(getAdminPrisma(), async tx => {
      const result = await acceptTeamInviteWithinTransaction({ prisma: tx, teamInviteId: id, userId, config: config(), now: new Date() });
      if (rollback) throw new Error('Forced admission rollback');
      return result;
    });
  }
  async function link(f: Awaited<ReturnType<typeof suite.subject>>, options: { maxUses?: number; expiresAt?: Date } = {}) {
    const token = randomUUID();
    const row = await suite.db.teamInviteLink.create({ data: { orgId: f.org.id, teamId: f.team.id,
      tokenHash: hashEmailToken(token, process.env.SHARED_SECRET!), roleToAssign: 'member',
      maxUses: options.maxUses ?? 10, expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000) } });
    return { token, row };
  }
  function redeem(token: string, userId: string, limits: Record<string, number> = {}) {
    return redeemTeamInviteLink({ token, userId, domain, config: config(limits) }, { prisma: getAdminPrisma() });
  }

  it('publishes team-avatar create, replacement and deletion through real HTTP', async () => {
    const f = await suite.subject(), path = `/org/organisations/${f.org.id}/teams/${f.team.id}/avatar`;
    for (const fill of [0x21, 0x31]) {
      const boundary = 'directory-team-avatar';
      const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, fill)]);
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      expect((await socketRequest(base, path + query, { method: 'PUT', headers: { ...f.headers,
        'content-type': `multipart/form-data; boundary=${boundary}` }, body })).status).toBe(200);
      expect(Buffer.from((await suite.db.teamAvatar.findUniqueOrThrow({ where: { teamId: f.team.id } })).data)).toEqual(png);
    }
    expect((await socketRequest(base, path + query, { method: 'DELETE', headers: f.headers })).status).toBe(200);
    expect(await suite.db.teamAvatar.count({ where: { teamId: f.team.id } })).toBe(0);
    expect(await events(f.org.id)).toEqual([1n, 2n, 3n].map(revision => ({ revision, kind: 'team.changed', subjectId: null, teamId: f.team.id })));
  });

  it('accepts new and freshly re-invited members atomically and invalidates a prior owner-only profile scope', async () => {
    const f = await suite.subject(), target = await user();
    const previous = await suite.db.organisation.create({ data: { domain, name: 'Prior owner scope', slug: randomUUID(), ownerId: target.id } });
    await accept((await invite(f, target)).id, target.id);
    const member = await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.org.id, userId: target.id } } });
    const seat = await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: f.team.id, userId: target.id } } });
    expect((await suite.db.user.findUniqueOrThrow({ where: { id: target.id } })).name).toBe('Invited canonical name');
    expect(await events(previous.id)).toEqual([{ revision: 1n, kind: 'profile.changed', subjectId: target.id, teamId: null }]);
    expect((await socketRequest(base, `/org/organisations/${f.org.id}/members/${target.id}` + query,
      { method: 'DELETE', headers: f.headers })).status).toBe(200);
    await accept((await invite(f, target)).id, target.id);
    expect(await suite.db.orgMember.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ status: 'ACTIVE', role: 'member' });
    expect(await suite.db.teamMember.findUniqueOrThrow({ where: { id: seat.id } })).toMatchObject({ status: 'ACTIVE', teamRole: 'member' });
    expect((await events(f.org.id)).map(row => row.kind)).toEqual(['membership.changed', 'membership.changed', 'membership.changed']);
  });

  it('rolls back invitation, name, both memberships, revision and events in one real transaction', async () => {
    const f = await suite.subject(), target = await user(), invitation = await invite(f, target);
    await expect(accept(invitation.id, target.id, true)).rejects.toThrow('Forced admission rollback');
    expect((await suite.db.user.findUniqueOrThrow({ where: { id: target.id } })).name).toBeNull();
    expect((await suite.db.teamInvite.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedAt).toBeNull();
    expect(await suite.db.orgMember.count({ where: { orgId: f.org.id, userId: target.id } })).toBe(0);
    expect(await suite.db.teamMember.count({ where: { teamId: f.team.id, userId: target.id } })).toBe(0);
    expect(await events(f.org.id)).toEqual([]);
    expect(await suite.db.directoryOrganisationRevision.findUnique({ where: { orgId: f.org.id } })).toBeNull();
  });

  it('serializes the final link use and publishes only the successful new membership', async () => {
    const f = await suite.subject(), first = await user(), second = await user(), invitation = await link(f, { maxUses: 1 });
    const results = await Promise.allSettled([redeem(invitation.token, first.id), redeem(invitation.token, second.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await suite.db.teamInviteLink.findUniqueOrThrow({ where: { id: invitation.row.id } })).useCount).toBe(1);
    const rows = await events(f.org.id);
    expect(rows).toEqual([{ revision: 1n, kind: 'membership.changed', subjectId: expect.any(String), teamId: f.team.id }]);
    expect(await suite.db.orgMember.count({ where: { orgId: f.org.id, userId: { in: [first.id, second.id] } } })).toBe(1);
  });

  it('does not consume a link or allocate events when exact-org user or team quotas refuse admission', async () => {
    const f = await suite.subject(), target = await user(), invitation = await link(f);
    await expect(redeem(invitation.token, target.id, { max_members_per_org: 2 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(redeem(invitation.token, target.id, { max_members_per_team: 2 })).rejects.toMatchObject({ statusCode: 400 });
    const other = await suite.db.team.create({ data: { orgId: f.org.id, name: 'Other seat', slug: randomUUID() } });
    await suite.db.teamMember.create({ data: { teamId: other.id, userId: target.id } });
    await expect(redeem(invitation.token, target.id, { max_team_memberships_per_user: 1 })).rejects.toMatchObject({ statusCode: 400 });
    expect((await suite.db.teamInviteLink.findUniqueOrThrow({ where: { id: invitation.row.id } })).useCount).toBe(0);
    expect(await suite.db.orgMember.count({ where: { orgId: f.org.id, userId: target.id } })).toBe(0);
    expect(await events(f.org.id)).toEqual([]);
  });

  it('rechecks actual expiry after an observed team-row lock wait without consuming the link', async () => {
    const f = await suite.subject(), target = await user(), expiresAt = new Date(Date.now() + 4_000);
    const invitation = await link(f, { expiresAt });
    let entered!: () => void, release!: () => void, pid = 0;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = suite.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM teams WHERE id=${f.team.id} FOR UPDATE`;
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      entered(); await released;
    }, { timeout: 15_000 });
    await held;
    const outcome = redeem(invitation.token, target.id).then(() => ({ admitted: true }), error => ({ error }));
    try {
      await suite.waitForBlocked(pid);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now()) + 25));
    } finally { release(); await blocker; }
    expect(await outcome).toMatchObject({ error: { statusCode: 400 } });
    expect((await suite.db.teamInviteLink.findUniqueOrThrow({ where: { id: invitation.row.id } })).useCount).toBe(0);
    expect(await suite.db.orgMember.count({ where: { orgId: f.org.id, userId: target.id } })).toBe(0);
    expect(await events(f.org.id)).toEqual([]);
  });

  it('refuses a suspended team seat without lifting suspension or consuming a link', async () => {
    const f = await suite.subject(), invitation = await link(f);
    await suite.db.teamMember.update({ where: { teamId_userId: { teamId: f.team.id, userId: f.target.id } },
      data: { status: 'DEACTIVATED' } });
    await expect(redeem(invitation.token, f.target.id)).rejects.toMatchObject({ statusCode: 400, message: 'MEMBERSHIP_DEACTIVATED' });
    expect((await suite.db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: f.team.id, userId: f.target.id } } })).status).toBe('DEACTIVATED');
    expect((await suite.db.teamInviteLink.findUniqueOrThrow({ where: { id: invitation.row.id } })).useCount).toBe(0);
    expect(await events(f.org.id)).toEqual([]);
  });

  it('refuses a persisted unsupported link role before any membership or usage write', async () => {
    const f = await suite.subject(), target = await user(), invitation = await link(f);
    await suite.db.teamInviteLink.update({ where: { id: invitation.row.id }, data: { roleToAssign: 'unconfigured-role' } });
    await expect(redeem(invitation.token, target.id)).rejects.toMatchObject({ statusCode: 400 });
    expect((await suite.db.teamInviteLink.findUniqueOrThrow({ where: { id: invitation.row.id } })).useCount).toBe(0);
    expect(await suite.db.orgMember.count({ where: { orgId: f.org.id, userId: target.id } })).toBe(0);
    expect(await events(f.org.id)).toEqual([]);
  });

  it('refuses self-avatar upload when its signed user authority expires during an observed user-lock wait', async () => {
    const f = await suite.subject(), boundary = 'avatar-expiry-race';
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 0x21)]);
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const held = await suite.holdUser(f.owner.id);
    const token = await f.token('2s');
    const pending = socketRequest(base, `/avatar/me?domain=${domain}`, { method: 'PUT',
      headers: { ...f.headers, 'x-uoa-access-token': token, 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    try {
      await suite.waitForBlocked(held.pid);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, decodeJwt(token).exp! * 1000 - Date.now()) + 25));
    } finally { await held.release(); }
    expect((await pending).status).toBe(401);
    expect(await suite.db.userAvatar.count({ where: { userId: f.owner.id } })).toBe(0);
    expect(await events(f.org.id)).toEqual([]);
  });
});
