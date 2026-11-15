import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recoverInvitationMigration } from '../../src/cli/recover-invitation-migration.js';
import { failedMigration, migrationRoleFixture } from '../helpers/invitation-migration-role.js';

describe.skipIf(!process.env.DATABASE_URL)('invitation migration with the production owner privileges', () => {
  let fixture: Awaited<ReturnType<typeof migrationRoleFixture>>;
  let failedId: string;
  beforeAll(async () => { fixture = await migrationRoleFixture(); });
  afterAll(async () => { await fixture?.cleanup(); });

  it('reproduces the permission failure with the immutable SQL, including the unfinished Prisma attempt', async () => {
    const sql = await readFile(new URL(`../../prisma/migrations/${failedMigration}/migration.sql`, import.meta.url), 'utf8');
    const roles = await fixture.client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
    expect(roles.rows[0].rolsuper).toBe(false);
    await expect(fixture.client.query(sql)).rejects.toMatchObject({ code: '42501', message: 'permission denied for table billing_automatic_seat_changes' });
    await fixture.client.query('ROLLBACK');
    await fixture.copyMigration(failedMigration);
    expect(await fixture.deploy()).not.toBe(0);
    const failed = await fixture.client.query('SELECT id FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');
    expect(failed.rows).toHaveLength(1);
    failedId = failed.rows[0].id;
  }, 90_000);

  it('refuses changed checksums without granting privileges or resolving history', async () => {
    const original = (await fixture.client.query('SELECT checksum FROM _prisma_migrations WHERE id=$1', [failedId])).rows[0].checksum;
    await fixture.client.query('UPDATE _prisma_migrations SET checksum=$1 WHERE id=$2', ['0'.repeat(64), failedId]);
    try {
      await expect(recoverInvitationMigration(fixture.databaseUrl)).rejects.toThrow('unrecognised migration history');
      expect((await fixture.client.query("SELECT has_table_privilege(current_user,'billing_automatic_seat_changes','TRIGGER') AS allowed")).rows[0].allowed).toBe(false);
    } finally {
      await fixture.client.query('UPDATE _prisma_migrations SET checksum=$1 WHERE id=$2', [original, failedId]);
    }
  });

  it('refuses partial schema state and retains the failed attempt', async () => {
    await fixture.client.query('ALTER TABLE team_invites ADD COLUMN billing_seat_required boolean');
    try {
      await expect(recoverInvitationMigration(fixture.databaseUrl)).rejects.toThrow('rollback or ownership is unproven');
      expect((await fixture.client.query('SELECT rolled_back_at FROM _prisma_migrations WHERE id=$1', [failedId])).rows[0].rolled_back_at).toBeNull();
    } finally {
      await fixture.client.query('ALTER TABLE team_invites DROP COLUMN billing_seat_required');
    }
  });

  it('leaves an unrelated failed migration untouched', async () => {
    await fixture.client.query('UPDATE _prisma_migrations SET migration_name=$1 WHERE id=$2', ['unrelated_failure', failedId]);
    try {
      await expect(recoverInvitationMigration(fixture.databaseUrl)).rejects.toThrow('unrecognised migration history');
    } finally {
      await fixture.client.query('UPDATE _prisma_migrations SET migration_name=$1 WHERE id=$2', [failedMigration, failedId]);
    }
  });

  it('recovers once across two callers, preserves history, then migrates the remaining chain as the owner role', async () => {
    // Run the exact built command used by production, including Prisma resolve.
    const results = await Promise.all([fixture.recover(), fixture.recover()]);
    expect(results).toEqual([0, 0]);
    const prior = (await fixture.client.query('SELECT finished_at,rolled_back_at FROM _prisma_migrations WHERE id=$1', [failedId])).rows[0];
    expect(prior.finished_at).toBeNull(); expect(prior.rolled_back_at).not.toBeNull();
    await fixture.copyRemaining();
    expect(await fixture.deploy()).toBe(0);
    const attempts = await fixture.client.query('SELECT id,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=$1', [failedMigration]);
    expect(attempts.rows).toHaveLength(2);
    expect(attempts.rows.filter(row => row.finished_at && !row.rolled_back_at)).toHaveLength(1);
    expect((await fixture.client.query("SELECT has_table_privilege('uoa_app','billing_automatic_seat_changes','TRIGGER') AS app_trigger,has_table_privilege('uoa_admin','billing_automatic_seat_changes','DELETE') AS admin_delete")).rows[0]).toEqual({ app_trigger: false, admin_delete: false });
    expect(await recoverInvitationMigration(fixture.databaseUrl)).toBe(false);
  }, 90_000);

  it('prevents the failure on an upgrade that has not attempted the invitation migration', async () => {
    const clean = await migrationRoleFixture();
    try {
      expect(await recoverInvitationMigration(clean.databaseUrl)).toBe(false);
      await clean.copyRemaining();
      expect(await clean.deploy()).toBe(0);
      expect((await clean.client.query('SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NULL')).rows[0].count).toBe(0);
    } finally { await clean.cleanup(); }
  }, 150_000);
});
