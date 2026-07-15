import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

type TestDbHandle = {
  prisma: PrismaClient;
  schema: string;
  databaseUrl: string;
  cleanup: () => Promise<void>;
};

function apiRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../..');
}

function prismaBinPath(): string {
  const bin = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
  // In npm workspaces, binaries are often hoisted to the repo root `node_modules/.bin`.
  const local = path.join(apiRootDir(), 'node_modules', '.bin', bin);
  if (fs.existsSync(local)) return local;
  return path.join(apiRootDir(), '..', 'node_modules', '.bin', bin);
}

function withSchemaParam(databaseUrl: string, schema: string): string {
  const u = new URL(databaseUrl);
  u.searchParams.set('schema', schema);
  return u.toString();
}

function runPrisma(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync(prismaBinPath(), args, {
    cwd: apiRootDir(),
    env,
    stdio: 'ignore',
  });
}

export async function createTestDb(): Promise<TestDbHandle | null> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) return null;

  const schema = `test_${Date.now()}_${randomUUID().replace(/-/g, '')}`;
  const adminUrl = withSchemaParam(baseUrl, 'public');
  const testUrl = withSchemaParam(baseUrl, schema);

  // Prisma narrows search_path to the isolated schema. `citext` is a database-wide extension
  // installed in public, so expose a schema-local domain backed by public.citext before applying
  // migrations. The advisory lock makes first-time extension setup safe when Vitest starts many
  // DB-backed files concurrently.
  execFileSync(
    process.platform === 'win32' ? 'cmd' : 'bash',
    process.platform === 'win32'
      ? [
          '/c',
          `echo SELECT pg_advisory_lock(847291); CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public; CREATE SCHEMA IF NOT EXISTS "${schema}"; CREATE DOMAIN "${schema}".citext AS public.citext; SELECT pg_advisory_unlock(847291); | "${prismaBinPath()}" db execute --stdin --schema prisma/schema.prisma`,
        ]
      : [
          '-lc',
          `echo 'SELECT pg_advisory_lock(847291); CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public; CREATE SCHEMA IF NOT EXISTS "${schema}"; CREATE DOMAIN "${schema}".citext AS public.citext; SELECT pg_advisory_unlock(847291);' | "${prismaBinPath()}" db execute --stdin --schema prisma/schema.prisma`,
        ],
    {
      cwd: apiRootDir(),
      env: { ...process.env, DATABASE_URL: adminUrl },
      stdio: 'ignore',
    },
  );

  // Apply migrations into the isolated schema.
  runPrisma(['migrate', 'deploy'], { ...process.env, DATABASE_URL: testUrl });

  const prisma = new PrismaClient({
    datasources: { db: { url: testUrl } },
  });
  await prisma.$connect();

  const cleanup = async (): Promise<void> => {
    await prisma.$disconnect();
    execFileSync(
      process.platform === 'win32' ? 'cmd' : 'bash',
      process.platform === 'win32'
        ? [
            '/c',
            `echo DROP SCHEMA IF EXISTS "${schema}" CASCADE; | "${prismaBinPath()}" db execute --stdin --schema prisma/schema.prisma`,
          ]
        : [
            '-lc',
            `echo 'DROP SCHEMA IF EXISTS "${schema}" CASCADE;' | "${prismaBinPath()}" db execute --stdin --schema prisma/schema.prisma`,
          ],
      {
        cwd: apiRootDir(),
        env: { ...process.env, DATABASE_URL: adminUrl },
        stdio: 'ignore',
      },
    );
  };

  return { prisma, schema, databaseUrl: testUrl, cleanup };
}
