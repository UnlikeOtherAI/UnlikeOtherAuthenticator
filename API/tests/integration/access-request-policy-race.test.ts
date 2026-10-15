import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAdminPrisma } from '../../src/db/prisma.js';
import { asPrismaClient } from '../../src/db/tenant-context.js';
import { ensureUserAssignedToConfiguredAccessTarget } from '../../src/services/access-request.service.base.js';
import { setEntityLifecycle } from '../../src/services/internal-admin-lifecycle.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createProfileDirectoryFixture, profileDirectoryDomain as domain } from '../helpers/profile-directory-fixture.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
describe.skipIf(!process.env.DATABASE_URL)('access-request policy/user/directory lock hierarchy on PostgreSQL', () => {
  let suite: Awaited<ReturnType<typeof createProfileDirectoryFixture>>, retain = false;
  beforeAll(async () => { suite = await createProfileDirectoryFixture(); });
  afterEach(({ task }) => { if (task.result?.state === 'fail') retain = true; });
  afterAll(async () => { await suite?.close(retain); });

  it('commits access assignment and a concurrent policy-exclusive lifecycle writer without a lock-order cycle', async () => {
    const f = await suite.subject(), held = latch(), release = latch();
    const target = await suite.db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    const config = validateConfigFields(baseClientConfigPayload({ domain, org_features: { enabled: true },
      access_requests: { enabled: true, target_org_id: f.org.id, target_team_id: f.team.id } }));
    // Pause assignment after its entry locks, before target discovery. No
    // production hook or sleep guesses which transaction reached the window.
    const table = suite.db.$transaction(async tx => {
      await tx.$executeRaw`LOCK TABLE organisations IN ACCESS EXCLUSIVE MODE`;
      held.release(); await release.promise;
    }, { timeout: 15_000 });
    await held.promise;
    let assignmentPid = 0;
    const assignment = getAdminPrisma().$transaction(async tx => {
      assignmentPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await ensureUserAssignedToConfiguredAccessTarget({ prisma: asPrismaClient(tx), config, userId: target.id, now: new Date() });
    }, { timeout: 15_000 });
    const assignmentResult = assignment.then(() => ({ committed: true }), error => ({ error }));
    let lifecycle: Promise<unknown> | undefined;
    try {
      const deadline = Date.now() + 4_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [row] = await suite.db.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${assignmentPid} AND wait_event_type='Lock' AND wait_event='relation') AS blocked`;
        if (row.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      const claims = decodeJwt(suite.adminToken);
      lifecycle = setEntityLifecycle({ scope: 'USER', id: target.id, status: 'ACTIVE',
        actor: { userId: claims.sub!, tokenVersion: 0 } });
      // Correct order waits on assignment's shared policy lock. Reversed order
      // obtains exclusive policy and then waits on assignment's shared user key.
      await suite.waitForBlocked(assignmentPid);
    } finally { release.release(); await table; }
    const lifecycleResult = lifecycle?.then(() => ({ committed: true }), error => ({ error }));
    expect(await assignmentResult).toEqual({ committed: true });
    expect(await lifecycleResult).toEqual({ committed: true });
    expect(await suite.db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.org.id, userId: target.id } } }))
      .toMatchObject({ status: 'ACTIVE', role: 'member' });
    const changes = await suite.db.directoryChangeOutbox.findMany({ where: { orgId: f.org.id }, orderBy: { revision: 'asc' } });
    expect(changes.map(row => row.revision)).toEqual([1n, 2n]);
    expect(changes[0]).toMatchObject({ kind: 'membership.changed', subjectId: target.id, teamId: f.team.id });
  });
});
