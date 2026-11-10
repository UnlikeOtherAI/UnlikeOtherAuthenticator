import { randomUUID } from 'node:crypto';
import { requireAuthenticationEvidence } from './authentication-evidence.service.js';
import { MachineBinding, MACHINE_AUTHORIZATION_MS, MACHINE_CREDENTIAL_MS } from './machine-contract.js';
import { machineCanonicalJson, machineCredential, machineHash, machineRefused } from './machine-crypto.js';
import { assertMachineBinding, currentMachineAuthorization, lockMachine, machineClock, type MachineDb } from './machine-authority.service.js';
import type { machineBrowser } from './machine-browser.service.js';
import { assertNotBannedAtLogin } from './ban-policy.service.js';

type Browser = Awaited<ReturnType<typeof machineBrowser>>;
export async function machineConsentView(session: Browser, tx: MachineDb) {
  const now = await machineClock(tx);
  const [org, team, request, enrollments] = await Promise.all([
    tx.organisation.findUnique({ where: { id: session.orgId }, select: { name: true } }),
    tx.team.findUnique({ where: { id: session.teamId }, select: { name: true } }),
    session.requestId ? tx.machineAuthorizationRequest.findUnique({ where: { id: session.requestId } }) : null,
    tx.machineEnrollment.findMany({ where: { subject: session.subject, clientDomain: session.clientDomain,
      orgId: session.orgId, teamId: session.teamId }, orderBy: { createdAt: 'desc' }, take: 101 }),
  ]);
  return { version: 1, csrf_token: session.csrf, client_domain: session.clientDomain,
    organization_name: org?.name ?? '', team_name: team?.name ?? '', expires_at: session.expiresAt.toISOString(),
    request: request ? { request_id: request.id, device_name: request.deviceName,
      status: request.consentedAt ? 'authorized' : request.deniedAt ? 'denied' : request.expiresAt <= now ? 'expired' : 'pending',
      reauthorization: Boolean(request.enrollmentId), legacy_adoption: Boolean(request.legacyAssuranceId),
      expires_at: request.expiresAt.toISOString() } : null,
    enrollments: enrollments.slice(0, 100).map(row => ({ enrollment_id: row.id, device_name: row.deviceName,
      decision: row.status, reason: row.reason, created_at: row.createdAt.toISOString() })),
    truncated: enrollments.length > 100 };
}
export async function approveMachineConsent(session: Browser, approved: boolean, tx: MachineDb) {
  if (!session.requestId) machineRefused();
  await tx.$queryRaw`SELECT id FROM machine_authorization_requests WHERE id=${session.requestId}::uuid FOR UPDATE`;
  const request = await tx.machineAuthorizationRequest.findUnique({ where: { id: session.requestId } });
  const now = await machineClock(tx);
  if (!request || request.clientDomain !== session.clientDomain || request.configUrl !== session.configUrl ||
    request.configFingerprint !== session.configFingerprint || !request.proofHash) machineRefused();
  const binding = MachineBinding.parse(request.binding);
  if (binding.subject !== session.subject || binding.organization_id !== session.orgId || binding.team_id !== session.teamId) machineRefused();
  if (request.consentedAt || request.deniedAt) {
    if (Boolean(request.consentedAt) !== approved) machineRefused(409, 'MACHINE_REQUEST_CONFLICT');
    return { ok: true, version: 1, enrollment_id: request.resultEnrollmentId };
  }
  if (request.expiresAt <= now) machineRefused(409, 'MACHINE_REQUEST_EXPIRED');
  if (!approved) {
    await tx.machineAuthorizationRequest.update({ where: { id: request.id }, data: { deniedAt: now } });
    return { ok: true, version: 1, enrollment_id: null };
  }
  await assertNotBannedAtLogin({ userId: session.subject, domain: session.clientDomain, ip: null }, { prisma: tx });
  const evidence = await requireAuthenticationEvidence({ id: session.evidenceId, userId: session.subject,
    clientDomain: session.clientDomain, credentialEpoch: session.credentialEpoch, allowConsumed: true }, tx);
  const policy = await tx.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: {
    clientDomain: session.clientDomain, orgId: session.orgId } } });
  if (request.legacyAssuranceId) {
    // Explicit new HUMAN consent is authority. This historical reference is never validated,
    // refreshed, replaced or changed, and cannot grant any other product capability.
    const legacy = await tx.sessionAssurance.findUnique({ where: { id: request.legacyAssuranceId } });
    if (!legacy || legacy.userId !== session.subject || legacy.clientDomain !== session.clientDomain ||
      legacy.orgId !== session.orgId || legacy.teamId !== session.teamId) machineRefused();
  }
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`machine-binding:${session.clientDomain}:${binding.binding_id}`},0))::text`;
  const existing = await tx.machineEnrollment.findUnique({ where: { clientDomain_bindingId: {
    clientDomain: session.clientDomain, bindingId: binding.binding_id } } });
  if (Boolean(existing) !== Boolean(request.enrollmentId) || (existing && existing.id !== request.enrollmentId)) {
    machineRefused(409, 'MACHINE_REQUEST_CONFLICT');
  }
  const original = existing ? await lockMachine(session.clientDomain, existing.id, tx) : null;
  const predecessor = original ? await currentMachineAuthorization(original, tx) : null;
  if (original) {
    assertMachineBinding(original, binding);
    if (original.deviceName !== request.deviceName || predecessor?.keyThumbprint !== request.keyThumbprint ||
      ['device_revoked', 'all_devices_revoked', 'credential_replay', 'lineage_invalid'].includes(original.reason)) {
      machineRefused(409, 'MACHINE_NEW_GRANT_REQUIRED');
    }
  }
  const enrollmentId = original?.id ?? randomUUID(); const authorizationId = randomUUID();
  const generation = (original?.credentialGeneration ?? 0) + 1;
  if (generation > 2147483647) machineRefused(409, 'MACHINE_NEW_GRANT_REQUIRED');
  const expiresAt = new Date(Math.min(now.getTime() + MACHINE_AUTHORIZATION_MS,
    policy?.arrangementEnabled ? now.getTime() + policy.sessionMaxAgeSeconds * 1000 : Infinity,
    evidence.provenance === 'sso' ? evidence.sessionDeadline?.getTime() ?? now.getTime() : Infinity));
  if (expiresAt <= now) machineRefused();
  if (!original) await tx.machineEnrollment.create({ data: { id: enrollmentId, subject: binding.subject,
    clientDomain: session.clientDomain, audience: binding.audience, orgId: binding.organization_id,
    teamId: binding.team_id, purpose: binding.purpose, bindingId: binding.binding_id, deviceName: request.deviceName,
    originalAuthorizationId: authorizationId, currentAuthorizationId: authorizationId, lastActiveAt: now } });
  await tx.machineAuthorization.create({ data: { id: authorizationId, enrollmentId,
    predecessorId: predecessor?.id, requestId: request.id,
    consentHash: machineHash(machineCanonicalJson({ request_hash: request.requestHash, key_challenge_hash: machineHash(request.challenge),
      key_proof_hash: request.proofHash, authentication_evidence_id: evidence.id, credential_epoch: session.credentialEpoch,
      client_domain: session.clientDomain, binding, key_thumbprint: request.keyThumbprint, consented_at: now.toISOString() })),
    observedAt: evidence.observedAt, authenticatedAt: evidence.authenticatedAt, personalFactorAt: evidence.mfaCompletedAt,
    publicKey: request.publicKey as import('@prisma/client').Prisma.InputJsonValue,
    keyThumbprint: request.keyThumbprint, credentialEpoch: session.credentialEpoch,
    authenticationEvidenceId: session.evidenceId, legacyAssuranceId: request.legacyAssuranceId,
    provenance: evidence.provenance, methods: evidence.amr, personalFactorCompleted: Boolean(evidence.mfaCompletedAt),
    connectionId: evidence.connectionId, connectionRevision: evidence.connectionRevision,
    connectionGeneration: evidence.connectionGeneration, externalIdentityId: evidence.externalIdentityId,
    policyGeneration: policy?.generation ?? 0, consentedAt: now, expiresAt } });
  const token = machineCredential(enrollmentId, authorizationId, generation, request.id);
  await tx.machineCredential.create({ data: { enrollmentId, authorizationId, generation,
    operationId: request.id, tokenHash: machineHash(token), createdAt: now,
    expiresAt: new Date(Math.min(expiresAt.getTime(), now.getTime() + MACHINE_CREDENTIAL_MS)) } });
  if (original) await tx.machineEnrollment.update({ where: { id: enrollmentId }, data: { currentAuthorizationId: authorizationId,
    credentialGeneration: generation, sourceVersion: { increment: 1 }, status: 'allowed', reason: 'active', lastActiveAt: now } });
  await tx.machineAuthorizationRequest.update({ where: { id: request.id }, data: { consentedAt: now, resultEnrollmentId: enrollmentId } });
  return { ok: true, version: 1, enrollment_id: enrollmentId };
}
