import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getEnv, getPublicBaseUrl } from '../../src/config/env.js';
import { registerAccountDeletionRequestRoutes } from '../../src/routes/auth/account-deletion-request.js';
import { getAdminUsers } from '../../src/services/internal-admin.service.users.js';
import { encryptTwoFaSecret } from '../../src/utils/twofa-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import { computeTotp } from '../helpers/totp.js';

const store = vi.hoisted(() => ({ prisma: null as PrismaClient | null, mail: vi.fn() }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => store.prisma!, getPrisma: () => store.prisma! }));
vi.mock('../../src/services/email.service.js', () => ({ sendActionVerificationEmail: store.mail }));

describe.skipIf(!process.env.DATABASE_URL)('self-service account-deletion requests', () => {
  const app = Fastify();
  const startPath = '/auth/delete-account/start';
  const confirmPath = '/auth/delete-account/confirm';
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

  beforeAll(async () => {
    db = (await createTestDb())!;
    store.prisma = db.prisma;
    store.mail.mockResolvedValue(undefined);
    await app.register(cookie);
    registerAccountDeletionRequestRoutes(app);
  });
  afterAll(async () => {
    await app.close();
    await db?.cleanup();
  });

  function person(email = `${randomUUID()}@example.com`) {
    return db.prisma.user.create({ data: { email, userKey: email } });
  }

  async function start(email: string) {
    const response = await app.inject({ method: 'POST', url: startPath, payload: { email } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toEqual(expect.stringContaining('HttpOnly'));
    const session = String(response.headers['set-cookie']).split(';')[0]!;
    const { challengeId } = response.json<{ challengeId: string }>();
    const { code } = store.mail.mock.lastCall?.[0] as { code: string };
    return { session, challengeId, code };
  }

  function confirm(proof: Awaited<ReturnType<typeof start>>, twoFactorCode?: string) {
    return app.inject({ method: 'POST', url: confirmPath, headers: {
      cookie: proof.session, origin: getPublicBaseUrl(),
    }, payload: { challengeId: proof.challengeId, code: proof.code, twoFactorCode } });
  }

  it('accepts one confirmation under concurrency, queues only the exact account and preserves the original timestamp', async () => {
    const user = await person();
    const unrelated = await person();
    const proof = await start(user.email!);
    const wrongBrowser = await confirm({ ...proof, session: (await start(unrelated.email!)).session });
    expect(wrongBrowser.statusCode).toBe(401);
    expect((await db.prisma.verificationToken.findUniqueOrThrow({ where: { id: proof.challengeId } })).attemptCount).toBe(0);
    const responses = await Promise.all([confirm(proof), confirm(proof)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 401]);
    expect(responses.find(response => response.statusCode === 200)?.json()).toEqual({ submitted: true });
    const queued = await db.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(queued.lifecycleStatus).toBe('ACTIVE');
    expect(queued.accountDeletionRequestedAt).toBeInstanceOf(Date);
    expect((await confirm(await start(user.email!))).statusCode).toBe(200);
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).accountDeletionRequestedAt)
      .toEqual(queued.accountDeletionRequestedAt);
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: unrelated.id } })).accountDeletionRequestedAt).toBeNull();
    expect((await getAdminUsers(100, true)).map(row => row.id)).toContain(user.id);
    expect((await getAdminUsers(100, true)).map(row => row.id)).not.toContain(unrelated.id);
  });

  it('requires the enrolled authenticator and refuses proof after credential revocation', async () => {
    const personWithTotp = await person();
    const secret = 'JBSWY3DPEHPK3PXP';
    await db.prisma.user.update({ where: { id: personWithTotp.id }, data: {
      twoFaEnabled: true, twoFaSecret: encryptTwoFaSecret({ secret, sharedSecret: getEnv().SHARED_SECRET }),
    } });
    const proof = await start(personWithTotp.email!);
    expect((await confirm(proof)).statusCode).toBe(401);
    expect((await confirm(proof, computeTotp({ secret, nowMs: Date.now() }))).statusCode).toBe(200);
    const second = await person();
    const stale = await start(second.email!);
    await db.prisma.user.update({ where: { id: second.id }, data: { tokenVersion: { increment: 1 } } });
    expect((await confirm(stale)).statusCode).toBe(401);
  });

  it('does not queue unknown or domain-only identities and rejects cross-origin requests', async () => {
    const unknown = `${randomUUID()}@example.com`;
    const domainOnly = await db.prisma.user.create({ data: {
      email: unknown, userKey: `local.example.com|${unknown}`, domain: 'local.example.com',
    } });
    const count = store.mail.mock.calls.length;
    const crossSite = await app.inject({ method: 'POST', url: startPath,
      headers: { origin: 'https://other.example.com' }, payload: { email: unknown } });
    expect(crossSite.statusCode).toBe(403);
    expect(store.mail.mock.calls).toHaveLength(count);
    const proof = await start(unknown);
    expect((await confirm(proof)).statusCode).toBe(401);
    expect((await db.prisma.user.findUniqueOrThrow({ where: { id: domainOnly.id } })).accountDeletionRequestedAt).toBeNull();
    expect(await db.prisma.verificationToken.findUnique({ where: { id: proof.challengeId } })).toBeNull();
  });
});
