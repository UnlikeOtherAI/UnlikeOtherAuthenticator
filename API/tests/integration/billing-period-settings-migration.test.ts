import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const migration = '20261116090000_billing_period_settings';
const prismaRoot = fileURLToPath(new URL('../../prisma/', import.meta.url));
const WEEK = 7 * 86400_000;

// Production applies migrations as a non-superuser member of the table-owning role. This applies the
// migration that way over organisations already inside the earlier fourteen-day trial.
describe.skipIf(!process.env.DATABASE_URL)('billing period settings migration', () => {
  it('gives every running trial one week from the change and leaves ended ones alone', async () => {
    const baseUrl = process.env.DATABASE_URL as string;
    const name = `periods_${randomUUID().replaceAll('-', '')}`;
    const cache = fileURLToPath(new URL('../../node_modules/.cache/', import.meta.url));
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, 'period-settings-'));
    const migrations = join(directory, 'migrations');
    await mkdir(migrations);
    await cp(join(prismaRoot, 'schema.prisma'), join(directory, 'schema.prisma'));
    await cp(join(prismaRoot, 'migrations/migration_lock.toml'), join(migrations, 'migration_lock.toml'));
    const earlier = (await readdir(join(prismaRoot, 'migrations'))).filter(n => /^\d/.test(n) && n < migration);
    for (const item of earlier) await cp(join(prismaRoot, 'migrations', item), join(migrations, item), { recursive: true });
    const deploy = (databaseUrl: string) => new Promise<number | null>((accept, reject) => {
      const child = spawn(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'),
        'migrate', 'deploy', '--schema', join(directory, 'schema.prisma')], {
        env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'ignore', timeout: 170_000,
      });
      child.once('error', reject); child.once('close', accept);
    });
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`SELECT pg_advisory_lock(847291);
        CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
        CREATE SCHEMA "${name}"; CREATE DOMAIN "${name}".citext AS public.citext;
        SELECT pg_advisory_unlock(847291)`);
      const ownerUrl = new URL(baseUrl);
      ownerUrl.searchParams.set('schema', name);
      expect(await deploy(ownerUrl.toString())).toBe(0);
      await admin.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS
        PASSWORD 'isolated-migration-test' IN ROLE uoa_admin;
        GRANT USAGE,CREATE ON SCHEMA "${name}" TO uoa_admin;
        SET search_path TO "${name}";
        DO $$ DECLARE item record; BEGIN
          FOR item IN SELECT relname FROM pg_class WHERE relnamespace='"${name}"'::regnamespace AND relkind='r'
          LOOP EXECUTE format('ALTER TABLE %I OWNER TO uoa_admin',item.relname); END LOOP;
          FOR item IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='"${name}"'::regnamespace
          LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO uoa_admin',item.signature); END LOOP;
        END $$`);
      // Two organisations from before the change: one still inside its trial, one whose trial ended early.
      const ids = { running: randomUUID(), ended: randomUUID() };
      for (const [label, id] of Object.entries(ids)) {
        const user = randomUUID();
        await admin.query(`INSERT INTO users(id,email,user_key,updated_at) VALUES($1,$2,$3,now())`,
          [user, `${label}@periods.example.test`, `${name}-${label}`]);
        await admin.query(`INSERT INTO organisations(id,name,slug,domain,owner_id,updated_at) VALUES($1,$2,$2,$3,$4,now())`,
          [id, `${name}-${label}`, `${label}.periods.example.test`, user]);
      }
      const started = new Date(Date.now() - 86400_000);
      const fortnight = new Date(started.getTime() + 2 * WEEK);
      await admin.query(`INSERT INTO billing_nessie_seat_transitions(org_id,starts_at,ends_at,cohort_user_ids,ended_at)
        VALUES($1,$3,$4,'{}',NULL),($2,$3,$4,'{}',$5)`, [ids.running, ids.ended, started, fortnight, new Date()]);
      await cp(join(prismaRoot, 'migrations', migration), join(migrations, migration), { recursive: true });
      const roleUrl = new URL(ownerUrl);
      roleUrl.username = name; roleUrl.password = 'isolated-migration-test';
      expect(await deploy(roleUrl.toString())).toBe(0);

      const rows = (await admin.query(`SELECT t.org_id,t.starts_at,t.ends_at,c.trial_reset_at
        FROM billing_nessie_seat_transitions t CROSS JOIN billing_nessie_admission_cutover c`)).rows;
      const running = rows.find(row => row.org_id === ids.running), ended = rows.find(row => row.org_id === ids.ended);
      expect(running.ends_at.getTime()).toBe(running.trial_reset_at.getTime() + WEEK);
      expect(running.starts_at).toEqual(started);
      expect(ended.ends_at).toEqual(fortnight);
      // The deadline is immutable again, and a later trial may have any configured length.
      await expect(admin.query(`UPDATE billing_nessie_seat_transitions SET ends_at=ends_at+interval '1 day' WHERE org_id=$1`,
        [ids.running])).rejects.toThrow('cannot restart');
      expect((await admin.query(`SELECT * FROM billing_period_setting('unset')`)).rows)
        .toEqual([{ seat_trial_hours: 168, seat_renewal_grace_hours: 24 }]);
      const configured = (await admin.query(`SELECT proconfig FROM pg_proc WHERE pronamespace=$1::regnamespace
        AND proname IN ('billing_period_setting','billing_nessie_start_transition')`, [`"${name}"`])).rows;
      expect(configured).toHaveLength(2);
      for (const row of configured) expect(row.proconfig.join(' ')).toContain(`search_path=pg_catalog, ${name}, pg_temp`);
    } finally {
      await admin.query(`RESET search_path; DROP SCHEMA IF EXISTS "${name}" CASCADE; DROP ROLE IF EXISTS "${name}"`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 420_000);
});
