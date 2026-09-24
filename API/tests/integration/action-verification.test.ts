import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startActionVerification, verifyActionVerification } from '../../src/services/action-verification.service.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { createTestDb } from '../helpers/test-db.js';

describe.skipIf(!process.env.DATABASE_URL)('action-bound fresh verification', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('Database required');
    handle = created;
  });
  afterAll(async () => { if (handle) await handle.cleanup(); });

  async function fixture() {
    const email = `action-${randomUUID()}@example.com`;
    const user = await handle.prisma.user.create({ data: { email, userKey: email } });
    const config = validateConfigFields(baseClientConfigPayload({ domain: 'client.example.com', '2fa_enabled': false }));
    const context = {
      claims: { userId: user.id, tokenVersion: 0, email, domain: config.domain, clientId: 'test', role: 'user' as const },
      config, configUrl: 'https://client.example.com/config', actionDigest: 'a'.repeat(64),
    };
    const sendEmail = vi.fn(async () => undefined);
    const deps = { prisma: handle.prisma, sendEmail, generateCode: () => '123456' };
    const challenge = await startActionVerification({ ...context, description: 'Approve machine access' }, deps);
    return { context, deps, challenge, sendEmail, user };
  }

  it('emails the canonical recipient and consumes the proof only once', async () => {
    const f = await fixture();
    expect(f.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.user.email, code: '123456' }));
    const input = { ...f.context, challengeId: f.challenge.challengeId, code: '123456' };
    expect(await verifyActionVerification(input, f.deps)).toEqual({ verified: true, actionDigest: f.context.actionDigest });
    await expect(verifyActionVerification(input, f.deps)).rejects.toThrow('ACTION_VERIFICATION_FAILED');
  });

  it('commits failed guesses and locks out the correct code after five attempts', async () => {
    const f = await fixture();
    const input = { ...f.context, challengeId: f.challenge.challengeId, code: '000000' };
    for (let n = 0; n < 5; n++) await expect(verifyActionVerification(input, f.deps)).rejects.toThrow();
    expect((await handle.prisma.verificationToken.findUnique({ where: { id: input.challengeId } }))?.attemptCount).toBe(5);
    await expect(verifyActionVerification({ ...input, code: '123456' }, f.deps)).rejects.toThrow();
  });

  it('rejects a different action, domain, person, and expired challenge', async () => {
    const f = await fixture();
    const other = await fixture();
    const input = { ...f.context, challengeId: f.challenge.challengeId, code: '123456' };
    await expect(verifyActionVerification({ ...input, actionDigest: 'b'.repeat(64) }, f.deps)).rejects.toThrow();
    await expect(verifyActionVerification({ ...input, claims: other.context.claims }, f.deps)).rejects.toThrow();
    await expect(verifyActionVerification({ ...input, config: { ...input.config, domain: 'other.example.com' } }, f.deps))
      .rejects.toThrow();
    await expect(verifyActionVerification(input, { ...f.deps, now: () => new Date(Date.now() + 6 * 60_000) }))
      .rejects.toThrow();
  });

  it('invalidates the prior code when a new one is sent', async () => {
    const f = await fixture();
    await startActionVerification({ ...f.context, description: 'Approve machine access' }, f.deps);
    await expect(verifyActionVerification({ ...f.context, challengeId: f.challenge.challengeId, code: '123456' }, f.deps))
      .rejects.toThrow();
  });

  it('rejects a proof after credential revocation', async () => {
    const f = await fixture();
    await handle.prisma.user.update({ where: { id: f.user.id }, data: { tokenVersion: 1 } });
    await expect(verifyActionVerification({ ...f.context, challengeId: f.challenge.challengeId, code: '123456' }, f.deps))
      .rejects.toThrow();
  });

  it('allows exactly one concurrent consumption', async () => {
    const f = await fixture();
    const input = { ...f.context, challengeId: f.challenge.challengeId, code: '123456' };
    const outcomes = await Promise.allSettled([verifyActionVerification(input, f.deps), verifyActionVerification(input, f.deps)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('requires a fresh authenticator code for an enrolled account', async () => {
    const f = await fixture();
    await handle.prisma.user.update({ where: { id: f.user.id }, data: { twoFaEnabled: true } });
    await expect(verifyActionVerification({ ...f.context, challengeId: f.challenge.challengeId, code: '123456' }, f.deps))
      .rejects.toThrow();
  });
});
