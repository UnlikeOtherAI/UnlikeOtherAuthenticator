import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { machineHarness, machineDomain, type MachineHarness } from '../helpers/machine-fixture.js';
import { asPrismaClient } from '../../src/db/tenant-context.js';
import { lockMachine, machineAdmission, currentMachineAuthorization, machineClock } from '../../src/services/machine-authority.service.js';
import { MachineBinding } from '../../src/services/machine-contract.js';
import { machineCredential, machineHash } from '../../src/services/machine-crypto.js';

function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
describe('machine v1 validation, revocation, rotation and recovery races', () => {
  let h: MachineHarness;
  beforeAll(async () => { h = await machineHarness(); });
  afterAll(async () => { await h?.cleanup(); });
  async function waitForBlockedAdvisory(userId: string) {
    const identity = JSON.stringify(['uoa:refresh-session:user:v1', userId]);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [row] = await h.db.prisma.$queryRaw<{ count: number }[]>`WITH expected AS
        (SELECT hashtextextended(${identity},0) AS key)
        SELECT COUNT(*)::int AS count FROM pg_locks, expected
        WHERE locktype='advisory' AND NOT granted AND objsubid=1
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid::bigint=((expected.key >> 32) & 4294967295)
          AND objid::bigint=(expected.key & 4294967295)`;
      if (row.count > 0) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Expected the HTTP reader to wait on the held canonical authority lock');
  }

  it('a validation waiting for the authority lock observes the committed revocation', async () => {
    const f = await h.fixture(); const grant = await f.enrolled(); const body = await f.prepare('validate', grant.operation);
    const held = gate(), release = gate();
    const revoke = h.db.prisma.$transaction(async transaction => {
      const tx = asPrismaClient(transaction); const row = await lockMachine(machineDomain, grant.enrollmentId, tx);
      held.open(); await release.promise;
      await tx.machineEnrollment.update({ where: { id: row.id }, data: { status: 'revoked', reason: 'device_revoked', sourceVersion: { increment: 1 } } });
    }, { timeout: 20_000 });
    await held.promise;
    const validation = h.api('/enrollments/validate', body).then(value => value);
    try {
      await waitForBlockedAdvisory(f.user.id); release.open(); await revoke;
      const result = await validation;
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().decision).toMatchObject({ decision: 'revoked', reason: 'device_revoked', source_version: '2' });
    } finally { release.open(); await revoke; await validation; }
  });

  it('cached validation never replaces a later revocation and its earlier allowed receipt keeps its original finite deadline', async () => {
    const f = await h.fixture(); const grant = await f.enrolled(); const body = await f.prepare('validate', grant.operation);
    const allowed = await h.api('/enrollments/validate', body); const original = allowed.json().decision;
    expect(original.decision).toBe('allowed');
    const repeated = await h.api('/enrollments/validate', body);
    expect(repeated.json().decision.recheck_by).toBe(original.recheck_by);
    await f.operate('revoke', { ...grant.operation, request_id: randomUUID() });
    const fenced = await h.api('/enrollments/validate', body);
    expect(fenced.json().decision).toMatchObject({ decision: 'revoked', source_version: '2' });
    expect(original.decision).toBe('allowed'); // No claim that already-returned bytes can be cancelled.
    expect(Date.parse(original.recheck_by) - Date.parse(original.issued_at)).toBeLessThanOrEqual(30_000);
  });

  it('denial-only exact-key revoke cannot lose to a concurrent ordinary credential rotation', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const rotate = await f.prepare('rotate', grant.operation);
    const revoke = await f.prepare('revoke', { ...grant.operation, request_id: randomUUID() });
    const [a, b] = await Promise.all([h.api('/enrollments/rotate', rotate), h.api('/enrollments/revoke', revoke)]);
    expect(a.statusCode, a.body).toBe(200); expect(b.statusCode, b.body).toBe(200);
    expect(b.json().decision).toMatchObject({ decision: 'revoked', reason: 'device_revoked' });
    const row = await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: grant.enrollmentId } });
    expect(row.status).toBe('revoked'); expect(row.reason).toBe('device_revoked');
    expect(await h.db.prisma.machineAuthorization.count({ where: { enrollmentId: row.id } })).toBe(1);
    expect(await h.db.prisma.machineCredential.count({ where: { enrollmentId: row.id } })).toBeLessThanOrEqual(2);
  });

  it('recovery rereads an operation that commits while its HTTP request waits for the enrollment lock', async () => {
    const f = await h.fixture(); const grant = await f.enrolled(); const rotate = await f.prepare('rotate', grant.operation);
    const recovery = { ...MachineBinding.strip().parse(grant.operation), request_id: randomUUID(), operation_id: grant.operation.request_id };
    const challenge = await h.api('/recovery/challenge', recovery); expect(challenge.statusCode, challenge.body).toBe(200);
    const proof = f.proof(challenge.json());
    const held = gate(), release = gate(); let expectedCredential = '';
    // Stage the same atomic committed rows behind a real transaction barrier so
    // the reader is guaranteed to perform its first operation lookup before commit.
    const writer = h.db.prisma.$transaction(async transaction => {
      const tx = asPrismaClient(transaction); let row = await lockMachine(machineDomain, grant.enrollmentId, tx);
      const auth = await currentMachineAuthorization(row, tx); const now = await machineClock(tx);
      const predecessor = await tx.machineCredential.findUniqueOrThrow({ where: { operationId: grant.operationId } });
      expectedCredential = machineCredential(row.id, auth.id, 2, grant.operation.request_id);
      const expiresAt = new Date(Math.min(auth.expiresAt.getTime(), now.getTime() + 30 * 86_400_000));
      await tx.machineCredential.create({ data: { enrollmentId: row.id, authorizationId: auth.id, generation: 2,
        operationId: grant.operation.request_id, tokenHash: machineHash(expectedCredential), predecessorId: predecessor.id, createdAt: now, expiresAt } });
      row = await tx.machineEnrollment.update({ where: { id: row.id }, data: { credentialGeneration: 2, sourceVersion: { increment: 1 }, lastActiveAt: now } });
      const decision = await machineAdmission(row, auth, expiresAt, tx);
      await tx.machineChallenge.update({ where: { id: rotate.proof.challenge_id }, data: { consumedAt: now,
        proofHash: machineHash(rotate.proof.signature), result: { version: 1, decision } as Prisma.InputJsonValue } });
      held.open(); await release.promise;
    }, { timeout: 20_000 });
    await held.promise;
    const reader = h.api('/recovery', { ...recovery, proof }).then(value => value);
    try {
      await waitForBlockedAdvisory(f.user.id); release.open(); await writer;
      const result = await reader;
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({ outcome: 'recovered', credential: expectedCredential,
        credential_generation: 2, source_version: '2', fresh_validation_required: true });
      expect(result.json()).not.toHaveProperty('decision');
      expect(await h.db.prisma.machineCredential.count({ where: { enrollmentId: grant.enrollmentId } })).toBe(2);
    } finally { release.open(); await writer; await reader; }
  });

  it('global epoch reset takes precedence over a simultaneous personal-factor policy change', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    await h.db.prisma.user.update({ where: { id: f.user.id }, data: { tokenVersion: { increment: 1 }, twoFaEnabled: true } });
    const result = await f.operate('validate', grant.operation);
    expect(result.json().decision).toMatchObject({ decision: 'revoked', reason: 'security_reset' });
  });
});
