import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const startupScript = fileURLToPath(
  new URL('../../../docker/start-production.sh', import.meta.url),
);
const dockerfile = new URL('../../../Dockerfile', import.meta.url);
const temporaryDirectories: string[] = [];

type StartupResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o700);
}

async function fakeRuntime(): Promise<{ bin: string; capture: string }> {
  const root = await mkdtemp(join(tmpdir(), 'uoa-production-startup-'));
  temporaryDirectories.push(root);
  const bin = join(root, 'bin');
  const capture = join(root, 'capture');
  await Promise.all([mkdir(bin), mkdir(capture)]);
  await writeExecutable(
    join(bin, 'pnpm'),
    `#!/bin/sh
set -eu
printf '%s' "$DATABASE_URL" > "$CAPTURE_DIR/migration-database-url"
printf '%s' "\${DATABASE_ADMIN_URL:-}" > "$CAPTURE_DIR/migration-admin-url"
printf '%s' "$*" > "$CAPTURE_DIR/migration-arguments"
exit "\${FAKE_MIGRATION_EXIT:-0}"
`,
  );
  await writeExecutable(
    join(bin, 'node'),
    `#!/bin/sh
set -eu
printf '%s' "$DATABASE_URL" > "$CAPTURE_DIR/runtime-database-url"
printf '%s' "\${DATABASE_ADMIN_URL:-}" > "$CAPTURE_DIR/runtime-admin-url"
printf '%s' "\${migration_database_url:-}" > "$CAPTURE_DIR/runtime-migration-shadow"
printf '%s' "$*" > "$CAPTURE_DIR/runtime-arguments"
`,
  );
  return { bin, capture };
}

async function runStartup(
  runtime: { bin: string; capture: string },
  env: Record<string, string>,
): Promise<StartupResult> {
  const child = spawn('/bin/sh', [startupScript], {
    env: {
      CAPTURE_DIR: runtime.capture,
      PATH: `${runtime.bin}:/usr/bin:/bin`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stderr, stdout };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('production container startup database boundary', () => {
  it('migrates with the admin DSN but starts the API with the untouched runtime DSN', async () => {
    const runtime = await fakeRuntime();
    const runtimeUrl = 'postgresql://uoa_app:runtime-secret@db/auth';
    const adminUrl = 'postgresql://uoa_admin:admin-secret@db/auth';

    const result = await runStartup(runtime, {
      DATABASE_ADMIN_URL: adminUrl,
      DATABASE_URL: runtimeUrl,
      NODE_ENV: 'production',
    });

    expect(result.code).toBe(0);
    await expect(readFile(join(runtime.capture, 'migration-database-url'), 'utf8')).resolves.toBe(
      adminUrl,
    );
    await expect(readFile(join(runtime.capture, 'runtime-database-url'), 'utf8')).resolves.toBe(
      runtimeUrl,
    );
    await expect(readFile(join(runtime.capture, 'runtime-admin-url'), 'utf8')).resolves.toBe(
      adminUrl,
    );
    await expect(
      readFile(join(runtime.capture, 'runtime-migration-shadow'), 'utf8'),
    ).resolves.toBe('');
    await expect(readFile(join(runtime.capture, 'migration-arguments'), 'utf8')).resolves.toBe(
      '--filter @uoa/api exec prisma migrate deploy --schema prisma/schema.prisma',
    );
    await expect(readFile(join(runtime.capture, 'runtime-arguments'), 'utf8')).resolves.toBe(
      'API/dist/server.js',
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('runtime-secret');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('admin-secret');
  });

  it('fails closed before migration when production has no admin DSN', async () => {
    const runtime = await fakeRuntime();
    const runtimeUrl = 'postgresql://uoa_app:runtime-secret@db/auth';

    const result = await runStartup(runtime, {
      DATABASE_URL: runtimeUrl,
      NODE_ENV: 'production',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_ADMIN_URL is required for production migrations');
    expect(result.stderr).not.toContain(runtimeUrl);
    await expect(access(join(runtime.capture, 'migration-database-url'))).rejects.toBeDefined();
    await expect(access(join(runtime.capture, 'runtime-database-url'))).rejects.toBeDefined();
  });

  it('uses the runtime DSN as an explicit non-production fallback', async () => {
    const runtime = await fakeRuntime();
    const runtimeUrl = 'postgresql://local:local-secret@db/auth';

    const result = await runStartup(runtime, {
      DATABASE_URL: runtimeUrl,
      NODE_ENV: 'development',
    });

    expect(result.code).toBe(0);
    await expect(readFile(join(runtime.capture, 'migration-database-url'), 'utf8')).resolves.toBe(
      runtimeUrl,
    );
    await expect(readFile(join(runtime.capture, 'runtime-database-url'), 'utf8')).resolves.toBe(
      runtimeUrl,
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('local-secret');
  });

  it('does not treat an unknown environment name as a local fallback', async () => {
    const runtime = await fakeRuntime();
    const result = await runStartup(runtime, {
      DATABASE_URL: 'postgresql://uoa_app:runtime-secret@db/auth',
      NODE_ENV: 'staging',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'DATABASE_ADMIN_URL is required unless NODE_ENV is development or test',
    );
    expect(result.stderr).not.toContain('runtime-secret');
    await expect(access(join(runtime.capture, 'migration-database-url'))).rejects.toBeDefined();
  });

  it('does not start the API when migration fails', async () => {
    const runtime = await fakeRuntime();
    const result = await runStartup(runtime, {
      DATABASE_ADMIN_URL: 'postgresql://uoa_admin:admin-secret@db/auth',
      DATABASE_URL: 'postgresql://uoa_app:runtime-secret@db/auth',
      FAKE_MIGRATION_EXIT: '9',
      NODE_ENV: 'production',
    });

    expect(result.code).toBe(9);
    await expect(access(join(runtime.capture, 'runtime-database-url'))).rejects.toBeDefined();
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('runtime-secret');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('admin-secret');
  });

  it('keeps the reviewed startup script as the Docker entrypoint', async () => {
    const source = await readFile(dockerfile, 'utf8');

    expect(source).toContain(
      'COPY --chown=node:node docker/start-production.sh docker/start-production.sh',
    );
    expect(source).toContain('CMD ["sh", "/app/docker/start-production.sh"]');
    expect(source).not.toContain('CMD ["sh", "-c", "pnpm');
  });
});
