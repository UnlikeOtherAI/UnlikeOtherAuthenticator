import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { machineHarness, type MachineHarness } from '../helpers/machine-fixture.js';
import { MachineBinding } from '../../src/services/machine-contract.js';
import { historicalMachine } from '../helpers/machine-history-fixture.js';
import { machineCanonicalJson, machineHash, machineTranscript } from '../../src/services/machine-crypto.js';

describe('machine v1 atomic rotation, response-loss recovery and exact-lineage retirement', () => {
  let h: MachineHarness;
  beforeAll(async () => { h = await machineHarness(); });
  afterAll(async () => { await h?.cleanup(); });

  it('commits one successor for simultaneous retries and recovers the SAME credential after a lost reply', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const body = await f.prepare('rotate', grant.operation);
    const [a, b] = await Promise.all([h.api('/enrollments/rotate', body), h.api('/enrollments/rotate', body)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]); expect(a.json()).toEqual(b.json());
    expect(a.json().decision).toMatchObject({ credential_generation: 2, source_version: '2', decision: 'allowed' });
    expect(await h.db.prisma.machineCredential.count({ where: { enrollmentId: grant.enrollmentId } })).toBe(2);
    const recovered = await f.recover(grant.operation.request_id);
    expect(recovered.result.statusCode, recovered.result.body).toBe(200);
    expect(recovered.result.json()).toMatchObject({ outcome: 'recovered', credential: a.json().credential,
      credential_generation: 2, source_version: '2', fresh_validation_required: true });
    expect(recovered.result.json()).not.toHaveProperty('decision');
    const saved = await h.db.prisma.machineCredential.findUniqueOrThrow({ where: { operationId: grant.operation.request_id } });
    expect(recovered.result.json().credential_expires_at).toBe(saved.expiresAt.toISOString());
    const oldIssue = await h.api('/recovery/challenge', { ...MachineBinding.strip().parse(grant.operation),
      request_id: randomUUID(), operation_id: grant.operationId });
    expect(oldIssue.statusCode).toBe(409);
    expect(oldIssue.json().code).toBe('MACHINE_OPERATION_SUPERSEDED');
    const cached = await h.api('/enrollments/rotate', body);
    expect(cached.json().decision.recheck_by).toBe(a.json().decision.recheck_by);
  });

  it('conflicts competing operations without minting a second successor or automatically revoking within the replay window', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const [one, two] = await Promise.all([f.prepare('rotate', grant.operation), f.prepare('rotate', { ...grant.operation, request_id: randomUUID() })]);
    const results = await Promise.all([h.api('/enrollments/rotate', one), h.api('/enrollments/rotate', two)]);
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 409]);
    const row = await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: grant.enrollmentId } });
    expect(row).toMatchObject({ credentialGeneration: 2, status: 'allowed', sourceVersion: 2n });
    expect(await h.db.prisma.machineCredential.count({ where: { enrollmentId: row.id } })).toBe(2);
    const altered = await h.api('/challenges', { operation: 'rotate', request: { ...grant.operation, source_version: '2' } });
    expect(altered.statusCode).toBe(409);
  });

  it('journal recovery first works beyond 120 seconds; blind consumed-predecessor rotation retires only that lineage', async () => {
    const f = await h.fixture(); const old = await historicalMachine(h, f, { successorAgeMs: 121_000 });
    const prior = await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: old.operation.enrollment_id } });
    const recovered = await f.recover(old.current.operationId, old.operation);
    expect(recovered.result.statusCode, recovered.result.body).toBe(200);
    expect(recovered.result.json()).toMatchObject({ outcome: 'recovered', credential_generation: 2, source_version: '2' });
    expect(await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: prior.id } })).toEqual(prior);
    const unrelated = await f.enrolled();
    const blind = await f.operate('rotate', old.operation);
    expect(blind.json().decision).toMatchObject({ decision: 'revoked', reason: 'credential_replay', source_version: '3' });
    expect((await f.operate('validate', unrelated.operation)).json().decision.decision).toBe('allowed');
    expect((await h.db.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).tokenVersion).toBe(f.user.tokenVersion);
  });

  it('makes proven consumed-predecessor replay terminal even when team access had already stopped it', async () => {
    const f = await h.fixture(); const grant = await historicalMachine(h, f, { successorAgeMs: 121_000 });
    await h.db.prisma.teamMember.delete({ where: { teamId_userId: { teamId: f.team.id, userId: f.user.id } } });
    expect(await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: grant.operation.enrollment_id } }))
      .toMatchObject({ status: 'access_removed', reason: 'access_removed', sourceVersion: 3n });
    const replay = await f.operate('rotate', grant.operation);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().decision).toMatchObject({ decision: 'revoked', reason: 'credential_replay', source_version: '4' });
    await h.db.prisma.teamMember.create({ data: { teamId: f.team.id, userId: f.user.id } });
    const recovered = await f.recover(grant.current.operationId, grant.operation);
    expect(recovered.result.statusCode, recovered.result.body).toBe(200);
    expect(recovered.result.json()).toMatchObject({ outcome: 'denied', decision: { decision: 'revoked', reason: 'credential_replay' } });
    expect(await h.db.prisma.machineCredential.count({ where: { enrollmentId: grant.operation.enrollment_id } })).toBe(2);
  });

  it('does not use obsolete validation to hold a live successor, and refuses changed proof/context', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    const oldValidation = await f.prepare('validate', grant.operation);
    const rotated = await f.operate('rotate', { ...grant.operation, request_id: randomUUID() });
    expect(rotated.statusCode).toBe(200);
    expect((await h.api('/enrollments/validate', oldValidation)).statusCode).toBe(409);
    expect((await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: grant.enrollmentId } })).status).toBe('allowed');
    const tampered = await h.api('/enrollments/validate', { ...oldValidation, team_id: randomUUID() });
    expect(tampered.statusCode).toBe(401);
  });

  it('requires an unexpired first-use challenge, including denial-only device revoke', async () => {
    const f = await h.fixture(); const grant = await f.enrolled();
    for (const operation of ['validate', 'rotate', 'revoke'] as const) {
      const input = { ...grant.operation, request_id: randomUUID() }; const id = randomUUID();
      const expiresAt = new Date(Date.now() - 1000);
      const hash = machineHash(machineCanonicalJson({ operation, request: { ...input, credential: machineHash(input.credential) } }));
      const transcript = machineTranscript({ domain: 'machine.example.com', operation, requestId: input.request_id, requestHash: hash, challengeId: id, expiresAt });
      await h.db.prisma.machineChallenge.create({ data: { id, clientDomain: 'machine.example.com', enrollmentId: grant.enrollmentId,
        operationId: input.request_id, operation, requestHash: hash, transcript, expiresAt } });
      const result = await h.api(`/enrollments/${operation}`, { ...input, proof: f.proof({ challenge_id: id, transcript }) });
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe('MACHINE_CHALLENGE_EXPIRED');
    }
    expect((await h.db.prisma.machineEnrollment.findUniqueOrThrow({ where: { id: grant.enrollmentId } })).status).toBe('allowed');
  });

  it.each([{ authorizationExpired: true, reason: 'authorization_expired' }, { credentialExpired: true, reason: 'credential_expired' },
    { corruptCredential: true, reason: 'lineage_invalid' }])('returns a durable typed stop for $reason without editing history', async ({ reason, ...options }) => {
    const f = await h.fixture(); const grant = await historicalMachine(h, f, options);
    const before = await h.db.prisma.machineCredential.findMany({ where: { enrollmentId: grant.operation.enrollment_id } });
    const result = await f.operate('validate', grant.operation);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().decision.reason).toBe(reason);
    expect(result.json().decision.recheck_by).toBe(result.json().decision.issued_at);
    expect(await h.db.prisma.machineCredential.findMany({ where: { enrollmentId: grant.operation.enrollment_id } })).toEqual(before);
  });

  it.each([{ status: 'reauthorization_required', reason: 'inactive' }, { status: 'access_removed', reason: 'access_removed' },
    { status: 'revoked', reason: 'security_reset' }])('terminally retires proven corruption even after $reason', async held => {
    const f = await h.fixture(); const grant = await historicalMachine(h, f, { corruptCredential: true });
    // Fictional persisted prior hold; canonical scope remains available for the
    // subsequent real human attempt to reauthorize this exact original binding.
    await h.db.prisma.machineEnrollment.update({ where: { id: grant.operation.enrollment_id }, data: {
      ...held, sourceVersion: { increment: 1 } } });
    const history = await h.db.prisma.machineAuthorization.findMany({ where: { enrollmentId: grant.operation.enrollment_id } });
    const result = await f.operate('validate', grant.operation);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().decision).toMatchObject({ decision: 'revoked', reason: 'lineage_invalid', source_version: '3' });
    const renewal = await h.api('/authorization-requests', { ...f.input, ...MachineBinding.strip().parse(grant.operation),
      enrollment_id: grant.operation.enrollment_id, request_id: randomUUID() });
    expect(renewal.statusCode, renewal.body).toBe(409);
    expect(renewal.json().code).toBe('MACHINE_NEW_GRANT_REQUIRED');
    expect(await h.db.prisma.machineAuthorization.findMany({ where: { enrollmentId: grant.operation.enrollment_id } })).toEqual(history);
  });
});
