import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

/**
 * `20260816140000_team_invite_actionable_invariants` against data a live deployment plausibly
 * holds.
 *
 * The suite deliberately re-runs the SHIPPED migration file rather than a paraphrase of it: the
 * isolated schema arrives fully migrated, the migration's own objects are dropped, dirty rows are
 * seeded underneath, and the real `migration.sql` is replayed. What is asserted is therefore what
 * production will execute.
 *
 * The scenarios are the ones that could break a deploy: duplicate actionable invites (which the
 * partial unique index cannot tolerate), case-variant addresses (the index keys on `lower(email)`),
 * actionable `owner` invitations (legal before this migration), and rows that already violate the
 * terminal-coherence rules and must therefore be preserved rather than rewritten or fatal.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);

function apiRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

/** Same resolution as `tests/helpers/test-db.ts`: workspace binaries may or may not be hoisted. */
function prismaBinPath(): string {
  const local = path.join(apiRootDir(), 'node_modules', '.bin', 'prisma');
  return fs.existsSync(local) ? local : path.join(apiRootDir(), '..', 'node_modules', '.bin', 'prisma');
}

function migrationSqlPath(): string {
  return path.join(
    apiRootDir(),
    'prisma',
    'migrations',
    '20260816140000_team_invite_actionable_invariants',
    'migration.sql',
  );
}

describe.skipIf(!hasDatabase)('team-invite actionable invariants migration', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;

  const seededIds = [
    'inv-dup-oldest',
    'inv-dup-mid',
    'inv-dup-newest',
    'inv-case-upper',
    'inv-case-lower',
    'inv-owner-actionable',
    'inv-owner-pending',
    'inv-owner-accepted',
    'inv-declined',
    'inv-revoked',
    'inv-denied-a',
    'inv-denied-b',
    'inv-incoherent',
  ];

  function replayMigration(): void {
    execFileSync(
      prismaBinPath(),
      ['db', 'execute', '--file', migrationSqlPath(), '--schema', 'prisma/schema.prisma'],
      {
        cwd: apiRootDir(),
        env: { ...process.env, DATABASE_URL: handle!.databaseUrl },
        stdio: 'ignore',
      },
    );
  }

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    const { prisma } = handle;

    // Undo this migration's DDL so the pre-migration shape can be seeded underneath it.
    await prisma.$executeRawUnsafe(
      'DROP INDEX IF EXISTS "team_invites_one_actionable_per_team_email"',
    );
    for (const constraint of [
      'team_invites_team_role_check',
      'team_invites_terminal_mutually_exclusive_check',
      'team_invites_acceptance_pair_check',
      'team_invites_accepted_approval_check',
    ]) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "team_invites" DROP CONSTRAINT IF EXISTS "${constraint}"`,
      );
    }

    await prisma.user.createMany({
      data: [
        { id: 'u-owner', userKey: 'k-owner', email: 'owner@example.com', name: 'Owner' },
        { id: 'u-acc', userKey: 'k-acc', email: 'accepted@example.com', name: 'Accepted' },
      ],
    });
    await prisma.organisation.create({
      data: {
        id: 'org-1',
        domain: 'client.example.com',
        name: 'Acme',
        slug: 'acme',
        ownerId: 'u-owner',
      },
    });
    await prisma.team.createMany({
      data: [
        { id: 'team-1', orgId: 'org-1', name: 'Core', slug: 'core' },
        { id: 'team-2', orgId: 'org-1', name: 'Ops', slug: 'ops' },
      ],
    });

    const base = { orgId: 'org-1', lastSentAt: new Date() };
    await prisma.teamInvite.createMany({
      data: [
        // Three actionable invites for one address — the case the index cannot tolerate.
        { ...base, id: 'inv-dup-oldest', teamId: 'team-1', email: 'dup@example.com', teamRole: 'member', createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { ...base, id: 'inv-dup-mid', teamId: 'team-1', email: 'dup@example.com', teamRole: 'member', createdAt: new Date('2026-02-01T00:00:00.000Z') },
        { ...base, id: 'inv-dup-newest', teamId: 'team-1', email: 'dup@example.com', teamRole: 'admin', approvalStatus: 'APPROVED', createdAt: new Date('2026-03-01T00:00:00.000Z') },
        // Case variants collide only because the index keys on lower(email).
        { ...base, id: 'inv-case-upper', teamId: 'team-1', email: 'Mixed@Example.com', teamRole: 'member', createdAt: new Date('2026-01-05T00:00:00.000Z') },
        { ...base, id: 'inv-case-lower', teamId: 'team-1', email: 'mixed@example.com', teamRole: 'member', createdAt: new Date('2026-01-06T00:00:00.000Z') },
        // Actionable owner invitations were legal before this migration.
        { ...base, id: 'inv-owner-actionable', teamId: 'team-2', email: 'newowner@example.com', teamRole: 'owner', createdAt: new Date('2026-01-10T00:00:00.000Z') },
        { ...base, id: 'inv-owner-pending', teamId: 'team-2', email: 'pendowner@example.com', teamRole: 'owner', approvalStatus: 'PENDING', createdAt: new Date('2026-01-11T00:00:00.000Z') },
        // Accepted owner invite: history, and must survive untouched.
        { ...base, id: 'inv-owner-accepted', teamId: 'team-2', email: 'oldowner@example.com', teamRole: 'owner', acceptedAt: new Date('2025-06-02T00:00:00.000Z'), acceptedUserId: 'u-acc', createdAt: new Date('2025-06-01T00:00:00.000Z') },
        // Terminal rows sharing the duplicated address must not be counted as duplicates.
        { ...base, id: 'inv-declined', teamId: 'team-1', email: 'dup@example.com', teamRole: 'member', declinedAt: new Date('2025-12-02T00:00:00.000Z'), createdAt: new Date('2025-12-01T00:00:00.000Z') },
        { ...base, id: 'inv-revoked', teamId: 'team-1', email: 'dup@example.com', teamRole: 'member', revokedAt: new Date('2025-12-04T00:00:00.000Z'), revokedReason: 'REPLACED', createdAt: new Date('2025-12-03T00:00:00.000Z') },
        // Two DENIED rows for one address: non-actionable, so they never collide.
        { ...base, id: 'inv-denied-a', teamId: 'team-1', email: 'denied@example.com', teamRole: 'member', approvalStatus: 'DENIED', createdAt: new Date('2026-01-20T00:00:00.000Z') },
        { ...base, id: 'inv-denied-b', teamId: 'team-1', email: 'denied@example.com', teamRole: 'member', approvalStatus: 'DENIED', createdAt: new Date('2026-01-21T00:00:00.000Z') },
        // Already violates terminal coherence: must survive the deploy, not fail or be rewritten.
        { ...base, id: 'inv-incoherent', teamId: 'team-2', email: 'weird@example.com', teamRole: 'member', declinedAt: new Date('2025-11-02T00:00:00.000Z'), revokedAt: new Date('2025-11-03T00:00:00.000Z'), revokedReason: 'REPLACED', createdAt: new Date('2025-11-01T00:00:00.000Z') },
      ],
    });

    replayMigration();
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  async function invite(id: string) {
    return await handle!.prisma.teamInvite.findUniqueOrThrow({ where: { id } });
  }

  it('applies over dirty data without failing the deploy', async () => {
    const rows = await handle!.prisma.teamInvite.findMany({
      where: { id: { in: seededIds } },
      select: { id: true },
    });
    // Nothing is deleted — invite history is audit history.
    expect(rows).toHaveLength(seededIds.length);
  });

  it('keeps the earliest duplicate actionable invite and revokes the rest as REPLACED', async () => {
    const oldest = await invite('inv-dup-oldest');
    expect(oldest.revokedAt).toBeNull();

    for (const id of ['inv-dup-mid', 'inv-dup-newest']) {
      const row = await invite(id);
      expect(row.revokedAt).not.toBeNull();
      // A set `revokedAt` always carries a reason (20260815090000's invariant).
      expect(row.revokedReason).toBe('REPLACED');
    }
  });

  it('deduplicates case-variant addresses, because the index keys on lower(email)', async () => {
    expect((await invite('inv-case-upper')).revokedAt).toBeNull();
    expect((await invite('inv-case-lower')).revokedAt).not.toBeNull();
  });

  it('terminalises actionable owner invitations as REVOKED, not REPLACED', async () => {
    for (const id of ['inv-owner-actionable', 'inv-owner-pending']) {
      const row = await invite(id);
      expect(row.revokedAt).not.toBeNull();
      // Nothing superseded these; they were cancelled.
      expect(row.revokedReason).toBe('REVOKED');
      expect(row.teamRole).toBe('owner');
    }
  });

  it('leaves accepted owner history untouched', async () => {
    const row = await invite('inv-owner-accepted');
    expect(row.teamRole).toBe('owner');
    expect(row.acceptedAt).not.toBeNull();
    expect(row.revokedAt).toBeNull();
    expect(row.declinedAt).toBeNull();
  });

  it('does not disturb rows that were already terminal', async () => {
    const declined = await invite('inv-declined');
    expect(declined.declinedAt).not.toBeNull();
    expect(declined.revokedAt).toBeNull();

    const revoked = await invite('inv-revoked');
    expect(revoked.revokedReason).toBe('REPLACED');
    expect(revoked.revokedAt).toEqual(new Date('2025-12-04T00:00:00.000Z'));
  });

  it('leaves DENIED rows alone — they are outside the actionable predicate', async () => {
    for (const id of ['inv-denied-a', 'inv-denied-b']) {
      const row = await invite(id);
      expect(row.revokedAt).toBeNull();
      expect(row.approvalStatus).toBe('DENIED');
    }
  });

  it('preserves a row that already violated terminal coherence', async () => {
    // NOT VALID: the deploy must not fail on it, and must not silently rewrite it either.
    const row = await invite('inv-incoherent');
    expect(row.declinedAt).not.toBeNull();
    expect(row.revokedAt).not.toBeNull();
  });

  it('enforces one actionable invite per (team, lower(email)) afterwards', async () => {
    const insert = (email: string) =>
      handle!.prisma.teamInvite.create({
        data: {
          orgId: 'org-1',
          teamId: 'team-1',
          email,
          teamRole: 'member',
          lastSentAt: new Date(),
        },
      });

    await expect(insert('dup@example.com')).rejects.toThrow();
    // Same address, different case — the index normalises.
    await expect(insert('DUP@Example.com')).rejects.toThrow();
  });

  it('still accepts a second DENIED row for an address, which is not actionable', async () => {
    const row = await handle!.prisma.teamInvite.create({
      data: {
        orgId: 'org-1',
        teamId: 'team-1',
        email: 'denied@example.com',
        teamRole: 'member',
        approvalStatus: 'DENIED',
        lastSentAt: new Date(),
      },
    });
    expect(row.id).toBeTruthy();
  });

  it('refuses an owner invitation but allows a role the domain invented', async () => {
    const withRole = (email: string, teamRole: string) =>
      handle!.prisma.teamInvite.create({
        data: { orgId: 'org-1', teamId: 'team-1', email, teamRole, lastSentAt: new Date() },
      });

    await expect(withRole('brandnew@example.com', 'owner')).rejects.toThrow();
    // The team-role vocabulary is per-domain config the database cannot see, so the constraint is
    // `<> 'owner'` and NOT an `IN ('member','admin')` list — a domain's own role still writes.
    const lead = await withRole('lead@example.com', 'lead');
    expect(lead.teamRole).toBe('lead');
  });

  it('refuses newly incoherent terminal states', async () => {
    await expect(
      handle!.prisma.teamInvite.create({
        data: {
          orgId: 'org-1',
          teamId: 'team-1',
          email: 'both@example.com',
          teamRole: 'member',
          lastSentAt: new Date(),
          acceptedAt: new Date(),
          acceptedUserId: 'u-acc',
          declinedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    // Acceptance must name who accepted.
    await expect(
      handle!.prisma.teamInvite.create({
        data: {
          orgId: 'org-1',
          teamId: 'team-1',
          email: 'ghost@example.com',
          teamRole: 'member',
          lastSentAt: new Date(),
          acceptedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    // An accepted invite can never still be awaiting or refused approval.
    await expect(
      handle!.prisma.teamInvite.create({
        data: {
          orgId: 'org-1',
          teamId: 'team-1',
          email: 'unapproved@example.com',
          teamRole: 'member',
          lastSentAt: new Date(),
          approvalStatus: 'PENDING',
          acceptedAt: new Date(),
          acceptedUserId: 'u-acc',
        },
      }),
    ).rejects.toThrow();
  });
});
