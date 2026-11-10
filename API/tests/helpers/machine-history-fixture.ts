import { randomBytes, randomUUID } from 'node:crypto';
import { machineCredential, machineHash, machineThumbprint } from '../../src/services/machine-crypto.js';
import { MachineBinding, type MachineOperation } from '../../src/services/machine-contract.js';
import type { MachineHarness } from './machine-fixture.js';

/** Fictional historical persistence only: never evidence of human approval or an installed native broker. */
export async function historicalMachine(h: MachineHarness, f: Awaited<ReturnType<MachineHarness['fixture']>>, options: {
  successorAgeMs?: number; authorizationExpired?: boolean; credentialExpired?: boolean; corruptCredential?: boolean;
  enterprise?: { connectionId: string; identityId: string; connectionRevision: number; connectionGeneration: number; policyGeneration: number };
} = {}) {
  const now = Date.now(); const createdAt = new Date(now - 3_600_000);
  const enrollmentId = randomUUID(), authorizationId = randomUUID(), operationId = randomUUID();
  const binding = { ...MachineBinding.strip().parse(f.input), binding_id: randomUUID() };
  const original = options.corruptCredential ? 'uoa_machine_' + randomBytes(32).toString('base64url') : machineCredential(enrollmentId, authorizationId, 1, operationId);
  const authExpiry = new Date(options.authorizationExpired ? now - 1000 : now + 86_400_000);
  const credentialExpiry = new Date(options.credentialExpired || options.authorizationExpired ? now - 1000 : now + 3_600_000);
  await h.db.prisma.$transaction(async tx => {
    await tx.machineEnrollment.create({ data: { id: enrollmentId, clientDomain: 'machine.example.com', subject: binding.subject,
      audience: binding.audience, orgId: binding.organization_id, teamId: binding.team_id, purpose: binding.purpose,
      bindingId: binding.binding_id, deviceName: f.input.device_name, originalAuthorizationId: authorizationId,
      currentAuthorizationId: authorizationId, createdAt, lastActiveAt: new Date(now) } });
    await tx.machineAuthorization.create({ data: { id: authorizationId, enrollmentId, requestId: operationId,
      consentHash: machineHash('fictional historical consent fixture'), observedAt: createdAt, authenticatedAt: createdAt,
      publicKey: f.input.public_key, keyThumbprint: await machineThumbprint(f.input.public_key),
      credentialEpoch: f.user.tokenVersion, authenticationEvidenceId: 'fictional-historical-evidence-' + randomUUID(),
      provenance: options.enterprise ? 'sso' : 'independent', methods: [options.enterprise ? 'sso' : 'email_password'], personalFactorCompleted: false,
      policyGeneration: options.enterprise?.policyGeneration ?? 0, connectionId: options.enterprise?.connectionId,
      externalIdentityId: options.enterprise?.identityId, connectionRevision: options.enterprise?.connectionRevision,
      connectionGeneration: options.enterprise?.connectionGeneration,
      consentedAt: createdAt, expiresAt: authExpiry } });
    const first = await tx.machineCredential.create({ data: { enrollmentId, authorizationId, generation: 1,
      operationId, tokenHash: machineHash(original), createdAt, expiresAt: credentialExpiry } });
    if (options.successorAgeMs !== undefined) {
      const successorOperation = randomUUID();
      const token = machineCredential(enrollmentId, authorizationId, 2, successorOperation);
      await tx.machineCredential.create({ data: { enrollmentId, authorizationId, generation: 2, operationId: successorOperation,
        tokenHash: machineHash(token), predecessorId: first.id, createdAt: new Date(now - options.successorAgeMs), expiresAt: credentialExpiry } });
      await tx.machineEnrollment.update({ where: { id: enrollmentId }, data: { credentialGeneration: 2, sourceVersion: { increment: 1 } } });
    }
  });
  const operation: MachineOperation = { ...binding, request_id: randomUUID(), enrollment_id: enrollmentId,
    authorization_id: authorizationId, credential_generation: 1, source_version: '1', credential: original };
  const current = await h.db.prisma.machineCredential.findFirstOrThrow({ where: { enrollmentId }, orderBy: { generation: 'desc' } });
  return { operation, operationId, current, authExpiry, credentialExpiry };
}
