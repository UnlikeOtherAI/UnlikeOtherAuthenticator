import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '../helpers/test-db.js';
import { withDirectoryMutation } from '../../src/services/directory-mutation.service.js';

const database = describe.skipIf(!process.env.DATABASE_URL);
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
database('ordered directory transaction seam', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let db: PrismaClient;
  beforeAll(async () => { handle = await createTestDb(); db = handle!.prisma; }, 120_000);
  afterAll(async () => { await handle?.cleanup(); });

  it('publishes nothing when the enclosing transaction rolls back', async () => {
    await expect(db.$transaction(async tx => {
      await withDirectoryMutation(tx as unknown as PrismaClient,
        [{ orgId: 'rollback', kind: 'membership.changed', subjectId: 'subject' }], async () => undefined);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await db.directoryOrganisationRevision.findUnique({ where: { orgId: 'rollback' } })).toBeNull();
    expect(await db.directoryChangeOutbox.count({ where: { orgId: 'rollback' } })).toBe(0);
  });

  it('does not allocate a later revision until the prior mutation commits', async () => {
    const entered = gate(), release = gate(), secondStarted = gate();
    let secondPid = 0;
    const first = withDirectoryMutation(db, [{ orgId: 'ordered', kind: 'membership.changed', subjectId: 'first' }], async () => {
      entered.release(); await release.promise;
    });
    await entered.promise;
    const second = db.$transaction(async tx => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      secondPid = backend.pid; secondStarted.release();
      await withDirectoryMutation(tx as unknown as PrismaClient,
        [{ orgId: 'ordered', kind: 'membership.changed', subjectId: 'second' }], async () => undefined);
    });
    await secondStarted.promise;
    try {
      // Observe the actual advisory-lock waiter, rather than assuming a sleep
      // establishes transaction ordering on a busy CI worker.
      const deadline = Date.now() + 2000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${secondPid} AND locktype='advisory' AND NOT granted) AS waiting`;
        waiting = rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(await db.directoryChangeOutbox.count({ where: { orgId: 'ordered' } })).toBe(0);
    } finally { release.release(); await Promise.all([first, second]); }
    const rows = await db.directoryChangeOutbox.findMany({ where: { orgId: 'ordered' }, orderBy: { revision: 'asc' } });
    expect(rows.map(row => [row.revision, row.subjectId])).toEqual([[1n, 'first'], [2n, 'second']]);
  });

  it('locks a multi-org change in sorted order and preserves terminal deletion evidence', async () => {
    await Promise.all([
      withDirectoryMutation(db, [{ orgId: 'multi-b', kind: 'profile.changed' }, { orgId: 'multi-a', kind: 'profile.changed' }], async () => undefined),
      withDirectoryMutation(db, [{ orgId: 'multi-a', kind: 'profile.changed' }, { orgId: 'multi-b', kind: 'profile.changed' }], async () => undefined),
    ]);
    // No org row is required: deletion retains its cursor and final event.
    await withDirectoryMutation(db, [{ orgId: 'erased-org', kind: 'organisation.deleted' }], async () => undefined);
    expect(await db.directoryOrganisationRevision.findUnique({ where: { orgId: 'erased-org' } })).toMatchObject({ revision: 1n });
    expect(await db.directoryChangeOutbox.findFirst({ where: { orgId: 'erased-org' } })).toMatchObject({ kind: 'organisation.deleted', revision: 1n });
    for (const orgId of ['multi-a', 'multi-b']) {
      expect(await db.directoryOrganisationRevision.findUnique({ where: { orgId } })).toMatchObject({ revision: 2n });
    }
  });
});
