import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { consumeLoginSession } from '../../src/services/login-session-use.service.js';

describe('login-session-use.service', () => {
  it('stores only a fixed-length digest of the jti', async () => {
    const prisma = {
      loginSessionUse: {
        create: vi.fn(async () => ({ id: 'use-1' })),
      },
    };
    await consumeLoginSession({
      domain: 'client.example.com',
      jti: 'raw-sensitive-jti',
      expiresAtEpochSeconds: 1_800_000_000,
      prisma,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const data = prisma.loginSessionUse.create.mock.calls[0]?.[0].data;
    expect(data.jtiHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(data)).not.toContain('raw-sensitive-jti');
  });

  it('maps a unique collision to the generic authentication failure', async () => {
    const prisma = {
      loginSessionUse: {
        create: vi.fn(async () => {
          throw { code: 'P2002' };
        }),
      },
    };

    await expect(
      consumeLoginSession({
        domain: 'client.example.com',
        jti: 'replayed-jti',
        expiresAtEpochSeconds: 1_800_000_000,
        prisma,
        now: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ statusCode: 401, message: 'AUTHENTICATION_FAILED' });
  });

  it('migrates the digest ledger as an admin-only forced-RLS table', async () => {
    const sql = await readFile(
      new URL(
        '../../prisma/migrations/20260719070000_secure_login_session_continuations/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(sql).toContain('REVOKE ALL ON TABLE "login_session_uses" FROM "uoa_app"');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/"jti"\s/);
  });
});
