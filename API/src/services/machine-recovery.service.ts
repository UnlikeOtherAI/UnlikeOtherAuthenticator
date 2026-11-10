import { randomUUID } from 'node:crypto';
import { MachineRecoveryInput, MACHINE_CHALLENGE_MS } from './machine-contract.js';
import { machineCanonicalJson, machineCredential, machineEqual, machineHash, machineRefused, machineTranscript, verifyMachineProof } from './machine-crypto.js';
import { assertMachineBinding, currentMachineAuthorization, lockMachine, machineAdmission, machineClock, stopMachine,
  machineTransaction, type MachineDb } from './machine-authority.service.js';
import { challengeView, machineCredentialIsIntact } from './machine-operation.service.js';

type Recovery = import('zod').infer<typeof MachineRecoveryInput>;
async function recoveryTarget(domain: string, input: Recovery, tx: MachineDb) {
  let credential = await tx.machineCredential.findUnique({ where: { operationId: input.operation_id } });
  const operation = credential ? null : await tx.machineChallenge.findUnique({ where: {
    clientDomain_operationId: { clientDomain: domain, operationId: input.operation_id } } });
  if (!credential && (!operation || operation.operation !== 'rotate')) machineRefused(409, 'MACHINE_RECOVERY_PENDING');
  const row = await lockMachine(domain, credential?.enrollmentId ?? operation?.enrollmentId ?? machineRefused(), tx);
  // Rotation may have committed while this request waited for the enrollment lock.
  // Report that committed result, never a false not_committed result from an old read.
  credential = await tx.machineCredential.findUnique({ where: { operationId: input.operation_id } });
  assertMachineBinding(row, input);
  const auth = await currentMachineAuthorization(row, tx);
  if (credential && (credential.authorizationId !== auth.id || credential.generation !== row.credentialGeneration)) {
    machineRefused(409, 'MACHINE_OPERATION_SUPERSEDED');
  }
  return { row, auth, credential, operation };
}
export async function createMachineRecoveryChallenge(domain: string, value: unknown) {
  const input = MachineRecoveryInput.parse(value);
  return machineTransaction(async tx => {
    const { row } = await recoveryTarget(domain, input, tx);
    const hash = machineHash(machineCanonicalJson({ operation: 'recover', request: input }));
    const prior = await tx.machineChallenge.findUnique({ where: { clientDomain_operationId: {
      clientDomain: domain, operationId: input.request_id } } });
    if (prior) {
      if (prior.operation !== 'recover' || prior.requestHash !== hash || prior.enrollmentId !== row.id) machineRefused(409, 'MACHINE_REQUEST_CONFLICT');
      return challengeView(prior);
    }
    const id = randomUUID(); const now = await machineClock(tx);
    const expiresAt = new Date(now.getTime() + MACHINE_CHALLENGE_MS);
    return challengeView(await tx.machineChallenge.create({ data: { id, clientDomain: domain,
      enrollmentId: row.id, operationId: input.request_id, operation: 'recover', requestHash: hash, expiresAt,
      transcript: machineTranscript({ domain, operation: 'recover', requestId: input.request_id,
        requestHash: hash, challengeId: id, expiresAt }) } }));
  });
}
/** Recovery never rotates or creates a grant and never authorizes work by itself. */
export async function recoverMachineCredential(domain: string, input: Recovery,
  proof: { challenge_id: string; signature: string }) {
  return machineTransaction(async tx => {
    const target = await recoveryTarget(domain, input, tx);
    let { row } = target;
    const { auth, credential, operation } = target;
    const challenge = await tx.machineChallenge.findUnique({ where: { id: proof.challenge_id } });
    const now = await machineClock(tx);
    if (!challenge || challenge.operation !== 'recover' || challenge.clientDomain !== domain ||
      challenge.operationId !== input.request_id || challenge.enrollmentId !== row.id ||
      challenge.requestHash !== machineHash(machineCanonicalJson({ operation: 'recover', request: input })) || challenge.expiresAt <= now) machineRefused();
    verifyMachineProof(auth.publicKey, challenge.transcript, proof.signature);
    if (challenge.proofHash && !machineEqual(challenge.proofHash, machineHash(proof.signature))) machineRefused();
    await tx.machineChallenge.update({ where: { id: challenge.id }, data: {
      proofHash: machineHash(proof.signature), consumedAt: challenge.consumedAt ?? now } });
    if (!credential) return { version: 1, outcome: operation && operation.expiresAt <= now ? 'not_committed' : 'pending' };
    if (!await machineCredentialIsIntact(credential, auth.requestId, tx)) {
      row = await stopMachine(row, 'revoked', 'lineage_invalid', tx);
    }
    const decision = await machineAdmission(row, auth, credential.expiresAt, tx);
    if (decision.decision !== 'allowed') return { version: 1, outcome: 'denied', decision };
    const value = machineCredential(row.id, auth.id, credential.generation, credential.operationId);
    if (!machineEqual(machineHash(value), credential.tokenHash)) machineRefused(409, 'MACHINE_LINEAGE_INVALID');
    return { version: 1, outcome: 'recovered', original_grant_id: row.id, authorization_id: auth.id,
      credential_generation: row.credentialGeneration, source_version: row.sourceVersion.toString(),
      credential: value, credential_expires_at: credential.expiresAt.toISOString(),
      authorization_expires_at: auth.expiresAt.toISOString(), fresh_validation_required: true };
  });
}
