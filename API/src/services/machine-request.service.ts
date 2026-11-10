import type { Prisma } from '@prisma/client';
import { getPublicBaseUrl } from '../config/env.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import type { ClientConfig } from './config.service.js';
import { MachineBinding, MachineRequestInput, MACHINE_CHALLENGE_MS } from './machine-contract.js';
import { machineCanonicalJson, machineHash, machineMac, machineRefused, machineThumbprint, machineTranscript, verifyMachineProof } from './machine-crypto.js';
import { assertMachineBinding, currentMachineAuthorization, machineClock, machineTransaction, requireMachineProduct, type MachineDb } from './machine-authority.service.js';

export async function createMachineRequest(domain: string, configUrl: string, config: ClientConfig, value: unknown) {
  const input = MachineRequestInput.parse(value);
  if (input.audience !== `https://${domain}` || config.domain !== domain) machineRefused(400);
  const thumbprint = await machineThumbprint(input.public_key);
  const hash = machineHash(machineCanonicalJson({ operation: 'authorize', request: input }));
  return machineTransaction(async tx => {
    await requireMachineProduct(domain, tx);
    // Serialize intent publication without locking any human or effect source.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`machine-request:${domain}:${input.request_id}`},0))::text`;
    const prior = await tx.machineAuthorizationRequest.findUnique({ where: { id: input.request_id } });
    if (prior) {
      if (prior.clientDomain !== domain || prior.requestHash !== hash || prior.configUrl !== configUrl || prior.configFingerprint !== fingerprintClientConfig(config)) machineRefused(409, 'MACHINE_REQUEST_CONFLICT');
      return machineRequestView(prior);
    }
    if (input.enrollment_id) {
      const original = await tx.machineEnrollment.findUnique({ where: { id: input.enrollment_id } });
      if (!original || original.clientDomain !== domain) machineRefused();
      assertMachineBinding(original, input);
      const authorization = await currentMachineAuthorization(original, tx);
      if (authorization.keyThumbprint !== thumbprint || original.deviceName !== input.device_name) machineRefused();
      if (['device_revoked', 'all_devices_revoked', 'credential_replay', 'lineage_invalid'].includes(original.reason)) {
        machineRefused(409, 'MACHINE_NEW_GRANT_REQUIRED');
      }
    }
    const now = await machineClock(tx); const expiresAt = new Date(now.getTime() + MACHINE_CHALLENGE_MS);
    const row = await tx.machineAuthorizationRequest.create({ data: { id: input.request_id, clientDomain: domain,
      configUrl, configFingerprint: fingerprintClientConfig(config), requestHash: hash, binding: MachineBinding.strip().parse(input), publicKey: input.public_key,
      keyThumbprint: thumbprint, deviceName: input.device_name, enrollmentId: input.enrollment_id,
      legacyAssuranceId: input.legacy_assurance_id,
      challenge: machineTranscript({ domain, operation: 'authorize', requestId: input.request_id,
        requestHash: hash, challengeId: input.request_id, expiresAt }), expiresAt } });
    return machineRequestView(row);
  });
}
function machineRequestView(row: { id: string; challenge: string; expiresAt: Date; configUrl: string; binding: Prisma.JsonValue }) {
  const url = new URL('/auth', getPublicBaseUrl());
  url.searchParams.set('config_url', row.configUrl);
  url.searchParams.set('machine_request_id', row.id);
  // No product authorization code may accidentally complete this flow.
  url.searchParams.set('code_challenge', machineMac('request-pkce', row.id));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', row.id);
  const binding = MachineBinding.parse(row.binding);
  url.searchParams.set('team_hint', binding.team_id);
  return { version: 1, request_id: row.id, challenge_id: row.id, transcript: row.challenge,
    expires_at: row.expiresAt.toISOString(), authorization_url: url.toString() };
}
export async function proveMachineRequest(domain: string, id: string, proof: { challenge_id: string; signature: string }) {
  return machineTransaction(async tx => {
    await tx.$queryRaw`SELECT id FROM machine_authorization_requests WHERE id=${id}::uuid FOR UPDATE`;
    const row = await tx.machineAuthorizationRequest.findUnique({ where: { id } });
    const now = await machineClock(tx);
    if (!row || row.clientDomain !== domain || proof.challenge_id !== id || row.expiresAt <= now) machineRefused();
    verifyMachineProof(row.publicKey, row.challenge, proof.signature);
    const proofHash = machineHash(proof.signature);
    if (row.proofHash && row.proofHash !== proofHash) machineRefused(409, 'MACHINE_REQUEST_CONFLICT');
    await tx.machineAuthorizationRequest.update({ where: { id }, data: { proofHash } });
    return { ok: true, version: 1 };
  });
}
export async function machineRequestResult(domain: string, id: string, tx: MachineDb) {
  const row = await tx.machineAuthorizationRequest.findUnique({ where: { id } });
  if (!row || row.clientDomain !== domain) machineRefused();
  return { version: 1, request_id: id, status: row.consentedAt ? 'authorized' : row.deniedAt ? 'denied' :
    row.expiresAt <= await machineClock(tx) ? 'expired' : 'pending',
    enrollment_id: row.resultEnrollmentId, operation_id: row.consentedAt ? row.id : null };
}
