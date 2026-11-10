import { randomUUID } from 'node:crypto';
import type { MachineCredential, Prisma } from '@prisma/client';
import { MachineOperationInput, MACHINE_CHALLENGE_MS, MACHINE_CREDENTIAL_MS, MACHINE_REPLAY_MS,
  type MachineOperation, type MachineOperationKind } from './machine-contract.js';
import { machineCanonicalJson, machineCredential, machineEqual, machineHash, machineRefused, machineTranscript, verifyMachineProof } from './machine-crypto.js';
import { assertMachineBinding, currentMachineAuthorization, lockMachine, machineAdmission, machineClock,
  machineTransaction, stopMachine, type MachineDb } from './machine-authority.service.js';

function operationHash(operation: string, input: MachineOperation) {
  return machineHash(machineCanonicalJson({ operation, request: { ...input, credential: machineHash(input.credential) } }));
}
async function authenticateCredential(domain: string, input: MachineOperation, tx: MachineDb) {
  const row = await lockMachine(domain, input.enrollment_id, tx);
  assertMachineBinding(row, input);
  const auth = await currentMachineAuthorization(row, tx);
  const credential = await tx.machineCredential.findUnique({ where: { tokenHash: machineHash(input.credential) } });
  if (!credential || credential.enrollmentId !== row.id || credential.authorizationId !== auth.id ||
    credential.authorizationId !== input.authorization_id || credential.generation !== input.credential_generation ||
    BigInt(input.source_version) > row.sourceVersion) machineRefused();
  return { row, auth, credential };
}
export async function createMachineChallenge(domain: string, kind: MachineOperationKind, value: unknown) {
  const input = MachineOperationInput.parse(value);
  return machineTransaction(async tx => {
    const { row } = await authenticateCredential(domain, input, tx);
    const hash = operationHash(kind, input);
    const prior = await tx.machineChallenge.findUnique({ where: { clientDomain_operationId: {
      clientDomain: domain, operationId: input.request_id } } });
    if (prior) {
      if (prior.requestHash !== hash || prior.operation !== kind || prior.enrollmentId !== row.id) machineRefused(409, 'MACHINE_REQUEST_CONFLICT');
      return challengeView(prior);
    }
    const id = randomUUID(); const now = await machineClock(tx);
    const expiresAt = new Date(now.getTime() + MACHINE_CHALLENGE_MS);
    return challengeView(await tx.machineChallenge.create({ data: { id, clientDomain: domain, enrollmentId: row.id,
      operationId: input.request_id, operation: kind, requestHash: hash, expiresAt,
      transcript: machineTranscript({ domain, operation: kind, requestId: input.request_id,
        requestHash: hash, challengeId: id, expiresAt }) } }));
  });
}
export function challengeView(row: { id: string; transcript: string; expiresAt: Date }) {
  return { version: 1, challenge_id: row.id, transcript: row.transcript, expires_at: row.expiresAt.toISOString() };
}
export async function performMachineOperation(domain: string, kind: MachineOperationKind, input: MachineOperation,
  proof: { challenge_id: string; signature: string }) {
  return machineTransaction(async tx => {
    const authenticated = await authenticateCredential(domain, input, tx);
    let { row, credential } = authenticated;
    const { auth } = authenticated;
    const challenge = await tx.machineChallenge.findUnique({ where: { id: proof.challenge_id } });
    const now = await machineClock(tx);
    if (!challenge || challenge.clientDomain !== domain || challenge.enrollmentId !== row.id || challenge.operation !== kind ||
      challenge.operationId !== input.request_id || challenge.requestHash !== operationHash(kind, input)) machineRefused();
    verifyMachineProof(auth.publicKey, challenge.transcript, proof.signature);
    if (challenge.proofHash && !machineEqual(challenge.proofHash, machineHash(proof.signature))) machineRefused();
    if (!challenge.consumedAt && challenge.expiresAt <= now) machineRefused(409, 'MACHINE_CHALLENGE_EXPIRED');
    if (!await machineCredentialIsIntact(credential, auth.requestId, tx)) {
      row = await stopMachine(row, 'revoked', 'lineage_invalid', tx);
    }
    // Denial-only revocation cannot lose to ordinary credential rotation. The
    // exact current HUMAN authorization and key must still match; an old
    // authorization cannot retire a legitimately reauthorized successor.
    if (kind === 'revoke') {
      if (!['device_revoked', 'all_devices_revoked', 'credential_replay', 'lineage_invalid'].includes(row.reason)) {
        row = await tx.machineEnrollment.update({ where: { id: row.id }, data: { status: 'revoked',
          reason: 'device_revoked', sourceVersion: { increment: 1 } } });
      }
      if (!challenge.consumedAt) await tx.machineChallenge.update({ where: { id: challenge.id }, data: {
        consumedAt: now, proofHash: machineHash(proof.signature) } });
      return { version: 1, decision: await machineAdmission(row, auth, credential.expiresAt, tx) };
    }
    // Correct signed predecessor reuse has a narrow explicit theft policy. A wrong key or
    // unknown token never gets to this mutation and cannot revoke an unrelated enrollment.
    if (kind === 'rotate' && credential.generation < row.credentialGeneration) {
      const successor = await tx.machineCredential.findUnique({ where: { predecessorId: credential.id } });
      if (!successor || !validSuccessor(credential, successor)) {
        row = await stopMachine(row, 'revoked', 'lineage_invalid', tx);
      } else if (now.getTime() - successor.createdAt.getTime() > MACHINE_REPLAY_MS) {
        row = await stopMachine(row, 'revoked', 'credential_replay', tx);
      } else if (successor.operationId !== input.request_id || successor.generation !== row.credentialGeneration) {
        machineRefused(409, 'MACHINE_OPERATION_SUPERSEDED');
      } else credential = successor;
    }
    // An obsolete validation credential cannot expire or hold its live successor.
    if (kind === 'validate' && credential.generation !== row.credentialGeneration) machineRefused(409, 'MACHINE_OPERATION_SUPERSEDED');
    let decision = await machineAdmission(row, auth, credential.expiresAt, tx);
    if (decision.decision !== 'allowed') return { version: 1, decision };
    if (credential.generation !== row.credentialGeneration) machineRefused(409, 'MACHINE_OPERATION_SUPERSEDED');
    if (challenge.result) {
      if (!challenge.consumedAt || now.getTime() - challenge.consumedAt.getTime() > MACHINE_REPLAY_MS) machineRefused(409, 'MACHINE_RECOVERY_REQUIRED');
      const result = challenge.result as { decision?: { source_version?: string; recheck_by?: string } };
      if (result.decision?.source_version !== row.sourceVersion.toString()) machineRefused(409, 'MACHINE_OPERATION_SUPERSEDED');
      // Replay returns the original deadline. Never extend a prepared capability on a cache hit.
      return { ...result, ...(kind === 'rotate' ? { credential: credentialValue(credential) } : {}) };
    }
    if (challenge.expiresAt <= now) machineRefused(409, 'MACHINE_CHALLENGE_EXPIRED');
    if (kind !== 'rotate' && credential.generation !== input.credential_generation) machineRefused(409, 'MACHINE_OPERATION_SUPERSEDED');
    if (kind === 'rotate') {
      if (row.sourceVersion.toString() !== input.source_version) machineRefused(409, 'MACHINE_OPERATION_SUPERSEDED');
      const generation = row.credentialGeneration + 1;
      if (generation > 2147483647) machineRefused(409, 'MACHINE_NEW_GRANT_REQUIRED');
      const token = machineCredential(row.id, auth.id, generation, input.request_id);
      credential = await tx.machineCredential.create({ data: { enrollmentId: row.id, authorizationId: auth.id,
        generation, tokenHash: machineHash(token), operationId: input.request_id, predecessorId: credential.id,
        createdAt: now, expiresAt: new Date(Math.min(auth.expiresAt.getTime(), now.getTime() + MACHINE_CREDENTIAL_MS)) } });
      row = await tx.machineEnrollment.update({ where: { id: row.id }, data: { credentialGeneration: generation,
        sourceVersion: { increment: 1 }, lastActiveAt: now } });
      decision = await machineAdmission(row, auth, credential.expiresAt, tx);
    } else {
      // A fresh key-proven use counts as activity. It cannot change authorization/credential expiry.
      await tx.machineEnrollment.update({ where: { id: row.id }, data: { lastActiveAt: now } });
    }
    const result = { version: 1, decision };
    await tx.machineChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now,
      proofHash: machineHash(proof.signature), result: result as Prisma.InputJsonValue } });
    return { ...result, ...(kind === 'rotate' ? { credential: credentialValue(credential) } : {}) };
  });
}
function credentialValue(row: MachineCredential): string {
  const value = machineCredential(row.enrollmentId, row.authorizationId, row.generation, row.operationId);
  if (!machineEqual(machineHash(value), row.tokenHash)) machineRefused(409, 'MACHINE_LINEAGE_INVALID');
  return value;
}
function validSuccessor(parent: MachineCredential, child: MachineCredential): boolean {
  return parent.enrollmentId === child.enrollmentId && parent.authorizationId === child.authorizationId &&
    parent.id === child.predecessorId && child.generation === parent.generation + 1;
}
export async function machineCredentialIsIntact(credential: MachineCredential, authorizationRequestId: string, tx: MachineDb): Promise<boolean> {
  const expected = machineCredential(credential.enrollmentId, credential.authorizationId, credential.generation, credential.operationId);
  if (!machineEqual(machineHash(expected), credential.tokenHash)) return false;
  if (!credential.predecessorId) return credential.operationId === authorizationRequestId;
  const parent = await tx.machineCredential.findUnique({ where: { id: credential.predecessorId } });
  return Boolean(parent && validSuccessor(parent, credential) && parent.expiresAt >= credential.createdAt &&
    machineEqual(machineHash(machineCredential(parent.enrollmentId, parent.authorizationId, parent.generation, parent.operationId)), parent.tokenHash));
}
