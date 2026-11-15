import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const failedMigration = '20261115155000_invitation_seat_funding';
export const permissionMigration = '20261115154500_invitation_trigger_privilege';
const prismaRoot = fileURLToPath(new URL('../../prisma/', import.meta.url));

export async function migrationRoleFixture() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is required');
  const name = `invitation_${randomUUID().replaceAll('-', '')}`;
  const root = fileURLToPath(new URL('../../node_modules/.cache/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'migration-role-'));
  const migrations = join(directory, 'migrations');
  await mkdir(migrations);
  await cp(join(prismaRoot, 'schema.prisma'), join(directory, 'schema.prisma'));
  await cp(join(prismaRoot, 'migrations/migration_lock.toml'), join(migrations, 'migration_lock.toml'));
  const names = (await readdir(join(prismaRoot, 'migrations'))).filter(n => /^\d/.test(n)).sort();
  for (const migration of names.filter(n => n < failedMigration && n !== permissionMigration)) {
    await cp(join(prismaRoot, 'migrations', migration), join(migrations, migration), { recursive: true });
  }
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`SELECT pg_advisory_lock(847291);
    CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
    CREATE SCHEMA "${name}"; CREATE DOMAIN "${name}".citext AS public.citext;
    SELECT pg_advisory_unlock(847291)`);
  const ownerUrl = new URL(baseUrl);
  ownerUrl.searchParams.set('schema', name);
  async function deploy(databaseUrl: string) {
    return new Promise<number | null>((accept, reject) => {
      const child = spawn(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'),
        'migrate', 'deploy', '--schema', join(directory, 'schema.prisma')], {
        env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'ignore', timeout: 90_000,
      });
      child.once('error', reject); child.once('close', accept);
    });
  }
  async function copyMigration(migration: string) {
    await cp(join(prismaRoot, 'migrations', migration), join(migrations, migration), { recursive: true });
  }
  try {
    if (await deploy(ownerUrl.toString()) !== 0) throw new Error('Historical migration fixture failed');
    await admin.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS
      PASSWORD 'isolated-migration-test' IN ROLE uoa_admin;
      GRANT USAGE,CREATE ON SCHEMA "${name}" TO uoa_admin;
      SET search_path TO "${name}";
      DO $$ DECLARE item record; BEGIN
        FOR item IN SELECT relname FROM pg_class WHERE relnamespace='"${name}"'::regnamespace AND relkind='r'
        LOOP EXECUTE format('ALTER TABLE %I OWNER TO uoa_admin',item.relname); END LOOP;
        FOR item IN SELECT relname FROM pg_class WHERE relnamespace='"${name}"'::regnamespace AND relkind='S'
        LOOP EXECUTE format('ALTER SEQUENCE %I OWNER TO uoa_admin',item.relname); END LOOP;
        FOR item IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='"${name}"'::regnamespace
        LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO uoa_admin',item.signature); END LOOP;
      END $$;
      REVOKE ALL ON billing_automatic_seat_changes FROM uoa_admin;
      GRANT SELECT,INSERT,UPDATE ON billing_automatic_seat_changes TO uoa_admin`);
    const roleUrl = new URL(ownerUrl);
    roleUrl.username = name; roleUrl.password = 'isolated-migration-test';
    const client = new pg.Client({ connectionString: roleUrl.toString() });
    await client.connect();
    await client.query(`SET search_path TO "${name}"`);
    return {
      admin, client, name, databaseUrl: roleUrl.toString(), copyMigration,
      deploy: () => deploy(roleUrl.toString()),
      recover: () => new Promise<number | null>((accept, reject) => {
        const child = spawn(process.execPath, [join(prismaRoot, '../dist/cli/recover-invitation-migration.js')], {
          env: { ...process.env, DATABASE_URL: roleUrl.toString() }, stdio: 'ignore', timeout: 60_000,
        });
        child.once('error', reject); child.once('close', accept);
      }),
      copyRemaining: async () => {
        for (const migration of names.filter(n => n >= permissionMigration)) await copyMigration(migration);
      },
      cleanup: async () => {
        await client.end();
        await admin.query(`DROP SCHEMA "${name}" CASCADE; DROP ROLE "${name}"`);
        await admin.end(); await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE; DROP ROLE IF EXISTS "${name}"`);
    await admin.end(); await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
