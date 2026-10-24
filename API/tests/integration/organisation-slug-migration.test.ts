import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migration = readFileSync(path.join(apiRoot,
  'prisma/migrations/20261024133000_organisation_slug_admission/migration.sql'), 'utf8');

describe.skipIf(!process.env.DATABASE_URL)('organisation address admission on populated databases', () => {
  const schema = `slug_migration_${randomUUID().replaceAll('-', '')}`;
  let admin: PrismaClient;
  let db: PrismaClient;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL!;
    admin = new PrismaClient({ datasources: { db: { url: base } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    // A pre-admission schema with the real columns used by the migration.
    // Duplicates exist before installation; no guard is disabled to manufacture them.
    await db.$executeRawUnsafe(`CREATE TABLE organisations (
      id text PRIMARY KEY, domain text NOT NULL, name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      slug varchar(63) NOT NULL, lifecycle_status text NOT NULL DEFAULT 'ACTIVE',
      UNIQUE(domain, slug))`);
    await db.$executeRawUnsafe(`INSERT INTO organisations(id, domain, name, slug, lifecycle_status) VALUES
      ('legacy-a', 'excluded.example', 'First legacy organisation', 'legacy-shared', 'ACTIVE'),
      ('legacy-b', 'workspace.excluded.example', 'Second legacy organisation', 'legacy-shared', 'ACTIVE'),
      ('unique', 'active.example', 'Unique organisation', 'unique-address', 'ACTIVE'),
      ('disabled', 'disabled.example', 'Disabled organisation', 'disabled-address', 'DISABLED'),
      ('deleted', 'deleted.example', 'Retained organisation', 'deleted-address', 'DELETED')`);
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'),
      'db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma'], {
      cwd: apiRoot, env: { ...process.env, DATABASE_URL: url.toString() },
      input: migration, stdio: ['pipe', 'ignore', 'pipe'],
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it('preserves every legacy organisation and reserves all lifecycle states', async () => {
    expect(await db.$queryRaw`SELECT id, slug FROM organisations ORDER BY id`).toEqual([
      { id: 'deleted', slug: 'deleted-address' },
      { id: 'disabled', slug: 'disabled-address' },
      { id: 'legacy-a', slug: 'legacy-shared' },
      { id: 'legacy-b', slug: 'legacy-shared' },
      { id: 'unique', slug: 'unique-address' },
    ]);
    expect(await db.$queryRaw`SELECT slug, org_id FROM organisation_slug_claims ORDER BY slug`).toEqual([
      { slug: 'deleted-address', org_id: 'deleted' },
      { slug: 'disabled-address', org_id: 'disabled' },
      { slug: 'legacy-shared', org_id: null },
      { slug: 'unique-address', org_id: 'unique' },
    ]);
  });

  it('allows ordinary legacy edits but refuses a third owner of a blocked label', async () => {
    await db.$executeRaw`UPDATE organisations SET name = 'Edited', slug = 'legacy-shared' WHERE id = 'legacy-a'`;
    await expect(db.$executeRaw`INSERT INTO organisations(id, domain, name, slug)
      VALUES ('attacker', 'other.example', 'Other', 'legacy-shared')`).rejects.toMatchObject({ code: 'P2010', meta: { code: '23505' } });
    expect(await db.$queryRaw`SELECT name FROM organisations WHERE id = 'legacy-a'`).toEqual([{ name: 'Edited' }]);
  });

  it('keeps an ambiguous reservation blocked when one legacy owner changes address', async () => {
    await db.$executeRaw`UPDATE organisations SET slug = 'legacy-moved' WHERE id = 'legacy-a'`;
    expect(await db.$queryRaw`SELECT org_id FROM organisation_slug_claims WHERE slug = 'legacy-shared'`)
      .toEqual([{ org_id: null }]);
    await expect(db.$executeRaw`UPDATE organisations SET slug = 'legacy-shared' WHERE id = 'unique'`)
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23505' } });
    await expect(db.organisation.update({ where: { id: 'unique' },
      data: { slug: 'legacy-shared' }, select: { id: true } })).rejects.toMatchObject({
      code: 'P2002', meta: { modelName: 'Organisation', target: ['slug'] },
    });
    expect(await db.$queryRaw`SELECT slug FROM organisations WHERE id = 'unique'`)
      .toEqual([{ slug: 'unique-address' }]);
  });

  it('pins occupancy reads to the trusted schema despite a hostile caller search path', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE organisation_slug_claims(slug text, org_id text)');
      await tx.$executeRawUnsafe('SET LOCAL search_path = pg_temp, pg_catalog');
      expect(await tx.$queryRawUnsafe(`SELECT "${schema}".uoa_organisation_slug_taken('unique-address') AS taken`))
        .toEqual([{ taken: true }]);
    });
  });
});
