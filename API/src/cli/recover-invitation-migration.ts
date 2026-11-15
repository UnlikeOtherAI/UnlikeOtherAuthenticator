import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migration = '20261115155000_invitation_seat_funding';
const checksum = 'c993b76bba8ee7d1aa0a0d1b4cb4f5d6c3f44f81f19d76bfd5b66fb306e1e33f';
const migrationFile = new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url);
const schemaFile = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));

async function resolveRolledBack(databaseUrl: string): Promise<void> {
  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, [cli, 'migrate', 'resolve', '--rolled-back', migration,
      '--schema', schemaFile], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'ignore', timeout: 30_000,
    });
    child.once('error', () => reject(new Error('Invitation migration resolution could not start')));
    child.once('close', code => code === 0 ? accept() : reject(new Error('Invitation migration resolution failed')));
  });
}

/** Only the checksum-pinned, transactional invitation migration is recoverable.
 * Preserve its failed row through Prisma's supported rollback marker; never mark
 * it applied, delete history, change customer rows, or recover another migration.
 */
export async function recoverInvitationMigration(databaseUrl: string): Promise<boolean> {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? 'public';
  url.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    await client.query("SET statement_timeout = '15s'; SET lock_timeout = '5s'");
    await client.query('SELECT set_config(\'search_path\',quote_ident($1),false)', [schema]);
    if (!(await client.query("SELECT to_regclass('_prisma_migrations') AS name")).rows[0].name) return false;
    // Serialise recovery replicas without holding Prisma's own lock during its CLI.
    await client.query('SELECT pg_advisory_lock(15451550,hashtext(current_schema()))');
    const unfinished = await client.query<{ id: string; migration_name: string; checksum: string }>(
      'SELECT id,migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL',
    );
    if (unfinished.rows.length === 0) return false;
    if (unfinished.rows.length !== 1 || unfinished.rows[0].migration_name !== migration
      || unfinished.rows[0].checksum !== checksum
      || createHash('sha256').update(await readFile(migrationFile)).digest('hex') !== checksum) {
      throw new Error('Invitation migration recovery refused: unrecognised migration history');
    }
    // Prisma uses this lock for its schema engine. An in-flight migration must
    // finish before we inspect rollback evidence or grant its missing privilege.
    await client.query('SELECT pg_advisory_lock(72707369)');
    const current = await client.query<{ id: string; checksum: string }>(
      'SELECT id,checksum FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL',
    );
    if (current.rows.length === 0) return false;
    if (current.rows.length !== 1 || current.rows[0].id !== unfinished.rows[0].id
      || current.rows[0].checksum !== checksum) {
      throw new Error('Invitation migration recovery refused: migration state changed');
    }
    const state = await client.query<{ clean: boolean; owner: boolean }>(`
      SELECT NOT EXISTS (
        SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT a.attisdropped
        AND ((c.relname='team_invites' AND a.attname=ANY(ARRAY['billing_seat_required',
          'billing_seat_source_invite_id','billing_seat_subscription_id','billing_seat_funded_at','billing_seat_ended_at']))
          OR (c.relname='billing_stripe_checkout_sessions' AND a.attname='initial_seat_invites')
          OR (c.relname='billing_automatic_seat_changes' AND a.attname IN ('invite_id','cancelled_without_charge')))
      ) AND to_regclass('team_invites_billing_seat_source_idx') IS NULL
        AND to_regclass('billing_invitation_seat_addition_once') IS NULL
        AND to_regprocedure('billing_enqueue_invitation_seat(text,text,integer,timestamp)') IS NULL
        AND to_regprocedure('billing_fund_initial_invitations()') IS NULL
        AND to_regprocedure('billing_fund_additional_invitation()') IS NULL
        AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='billing_automatic_seat_changes'::regclass
          AND attname='user_id' AND attnotnull AND NOT attisdropped) AS clean,
        pg_has_role(current_user,relowner,'USAGE') AS owner
      FROM pg_class WHERE oid='billing_automatic_seat_changes'::regclass
    `);
    if (!state.rows[0]?.clean || !state.rows[0].owner) {
      throw new Error('Invitation migration recovery refused: rollback or ownership is unproven');
    }
    // Repair the cause before making the old migration retryable. A concurrent
    // older revision can then apply the same immutable SQL safely as well.
    await client.query('GRANT TRIGGER ON billing_automatic_seat_changes TO uoa_admin');
    await client.query('SELECT pg_advisory_unlock(72707369)');
    await resolveRolledBack(databaseUrl);
    console.log(JSON.stringify({ kind: 'invitation-migration-recovered', migration,
      checksum, failedAttemptId: unfinished.rows[0].id }));
    return true;
  } finally {
    // Closing also releases both session locks on every error path.
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  recoverInvitationMigration(process.env.DATABASE_URL ?? '').catch(() => {
    // Errors from pg or Prisma may contain connection details. Log no raw error.
    console.error('Invitation migration recovery refused or failed; inspect migration state and database logs.');
    process.exitCode = 1;
  });
}
