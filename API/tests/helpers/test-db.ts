import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  return path.join(apiRootDir(), 'node_modules', '.bin', bin);
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

  // Create an isolated schema for this test file. Prisma migrate deploy will fail if the
  // schema doesn't exist.
  execFileSync(
    process.platform === 'win32' ? 'cmd' : 'bash',
    process.platform === 'win32'
      ? [
          '/c',
          `echo CREATE SCHEMA IF NOT EXISTS "${schema}"; | "${prismaBinPath()}" db execute --stdin`,
        ]
      : [
          '-lc',
          `echo 'CREATE SCHEMA IF NOT EXISTS "${schema}";' | "${prismaBinPath()}" db execute --stdin`,
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
            `echo DROP SCHEMA IF EXISTS "${schema}" CASCADE; | "${prismaBinPath()}" db execute --stdin`,
          ]
        : [
            '-lc',
            `echo 'DROP SCHEMA IF EXISTS "${schema}" CASCADE;' | "${prismaBinPath()}" db execute --stdin`,
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
