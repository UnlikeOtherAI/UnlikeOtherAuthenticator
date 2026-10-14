import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '../helpers/test-db.js';
import { withDirectoryMutation } from '../../src/services/directory-mutation.service.js';

const database = describe.skipIf(!process.env.DATABASE_URL);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
database('ordered directory transaction seam', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let db: PrismaClient;
  beforeAll(async () => {
    handle = await createTestDb();
    db = handle!.prisma;
  }, 120_000);
  afterAll(async () => {
    await handle?.cleanup();
  });

  it('records only the resolved tenant and keeps direct table access denied', async () => {
    const owner = await db.user.create({ data: { email: 'directory-owner@example.com', userKey: 'directory-owner@example.com' } });
    const org = await db.organisation.create({
      data: { domain: 'directory.example.com', name: 'Directory', slug: 'directory-context', ownerId: owner.id },
    });
    // Grants apply only to this disposable schema; no shared role attributes or
    // passwords are changed. SET LOCAL ROLE is automatically restored at end.
    const schema = handle!.schema;
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO uoa_app`);
    await db.$executeRawUnsafe(`GRANT SELECT ON "${schema}".directory_change_outbox TO uoa_app`);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE uoa_app');
      await tx.$executeRaw`SELECT set_config('app.org_id', ${org.id}, true)`;
      await withDirectoryMutation(
        tx as unknown as PrismaClient,
        [{ orgId: org.id, kind: 'membership.changed' }],
        async () => undefined,
      );
      expect(await tx.directoryChangeOutbox.findMany({ where: { orgId: org.id } })).toEqual([]);
    });
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE uoa_app');
        await tx.$executeRaw`SELECT set_config('app.org_id', ${org.id}, true)`;
        await withDirectoryMutation(
          tx as unknown as PrismaClient,
          [{ orgId: 'unrelated-org', kind: 'membership.changed' }],
          async () => undefined,
        );
      }),
    ).rejects.toThrow();
    expect(await db.directoryChangeOutbox.count({ where: { orgId: org.id } })).toBe(1);
    expect(
      await db.directoryOrganisationRevision.findUnique({ where: { orgId: 'unrelated-org' } }),
    ).toBeNull();
  });

  it('publishes nothing when the enclosing transaction rolls back', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await withDirectoryMutation(
          tx as unknown as PrismaClient,
          [{ orgId: 'rollback', kind: 'membership.changed', subjectId: 'subject' }],
          async () => undefined,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await db.directoryOrganisationRevision.findUnique({ where: { orgId: 'rollback' } }),
    ).toBeNull();
    expect(await db.directoryChangeOutbox.count({ where: { orgId: 'rollback' } })).toBe(0);
  });

  it('does not allocate a later revision until the prior mutation commits', async () => {
    const entered = gate(),
      release = gate(),
      secondStarted = gate();
    let secondPid = 0;
    const first = withDirectoryMutation(
      db,
      [{ orgId: 'ordered', kind: 'membership.changed', subjectId: 'first' }],
      async () => {
        entered.release();
        await release.promise;
      },
    );
    await entered.promise;
    const second = db.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      secondPid = backend.pid;
      secondStarted.release();
      await withDirectoryMutation(
        tx as unknown as PrismaClient,
        [{ orgId: 'ordered', kind: 'membership.changed', subjectId: 'second' }],
        async () => undefined,
      );
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
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(await db.directoryChangeOutbox.count({ where: { orgId: 'ordered' } })).toBe(0);
    } finally {
      release.release();
      await Promise.all([first, second]);
    }
    const rows = await db.directoryChangeOutbox.findMany({
      where: { orgId: 'ordered' },
      orderBy: { revision: 'asc' },
    });
    expect(rows.map((row) => [row.revision, row.subjectId])).toEqual([
      [1n, 'first'],
      [2n, 'second'],
    ]);
  });

  it('locks a multi-org change in sorted order and preserves terminal deletion evidence', async () => {
    await Promise.all([
      withDirectoryMutation(
        db,
        [
          { orgId: 'multi-b', kind: 'profile.changed' },
          { orgId: 'multi-a', kind: 'profile.changed' },
        ],
        async () => undefined,
      ),
      withDirectoryMutation(
        db,
        [
          { orgId: 'multi-a', kind: 'profile.changed' },
          { orgId: 'multi-b', kind: 'profile.changed' },
        ],
        async () => undefined,
      ),
    ]);
    // No org row is required: deletion retains its cursor and final event.
    await withDirectoryMutation(
      db,
      [{ orgId: 'erased-org', kind: 'organisation.deleted' }],
      async () => undefined,
    );
    await withDirectoryMutation(db, [{ orgId: 'erased-org', kind: 'profile.changed', subjectId: 'later-erasure' }], async () => undefined);
    expect(await db.directoryChangeOutbox.count({ where: { orgId: 'erased-org' } })).toBe(1);
    expect(
      await db.directoryOrganisationRevision.findUnique({ where: { orgId: 'erased-org' } }),
    ).toMatchObject({ revision: 1n });
    expect(
      await db.directoryChangeOutbox.findFirst({ where: { orgId: 'erased-org' } }),
    ).toMatchObject({ kind: 'organisation.deleted', revision: 1n });
    for (const orgId of ['multi-a', 'multi-b']) {
      expect(await db.directoryOrganisationRevision.findUnique({ where: { orgId } })).toMatchObject(
        { revision: 2n },
      );
    }
  });
});
