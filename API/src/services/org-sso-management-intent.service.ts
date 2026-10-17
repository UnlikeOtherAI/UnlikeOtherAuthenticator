import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { requireAuthenticationEvidence } from './authentication-evidence.service.js';

function withdrawn(): never { throw new AppError('FORBIDDEN', 403, 'SSO_MANAGEMENT_ACCESS_WITHDRAWN'); }
function refuse(): never { throw new AppError('FORBIDDEN', 403, 'SSO_MANAGEMENT_REAUTH_REQUIRED'); }
export async function createManagementIntent(input: { userId: string; credentialEpoch: number; clientDomain: string;
  orgId: string; authenticationEvidenceId?: string; browser: string }, tx: Prisma.TransactionClient) {
  const evidence = await requireAuthenticationEvidence({ id: input.authenticationEvidenceId, userId: input.userId,
    credentialEpoch: input.credentialEpoch, clientDomain: input.clientDomain }, tx);
  const org = await tx.organisation.findUnique({ where: { id: input.orgId }, select: { ownerId: true, lifecycleStatus: true } });
  if (!org || org.ownerId !== input.userId || org.lifecycleStatus !== 'ACTIVE') withdrawn();
  if (evidence.provenance !== 'independent' ||
    !evidence.authenticatedAt || evidence.observedAt.getTime() + 600000 <= Date.now()) refuse();
  return tx.orgSsoManagementIntent.create({ data: { userId: input.userId, credentialEpoch: input.credentialEpoch,
    clientDomain: input.clientDomain, orgId: input.orgId, authenticationEvidenceId: evidence.id,
    browserHash: hashAssuranceReference(input.browser), expiresAt: new Date(Math.min(evidence.expiresAt.getTime(), Date.now() + 600000)) } });
}

/** Called only by existing post-factor finalization. No product session or code is minted. */
export async function finishManagementIntent(input: { id: string; userId: string; credentialEpoch: number;
  clientDomain: string; authenticationEvidenceId?: string; twoFaCompleted: boolean }, tx: Prisma.TransactionClient) {
  const intent = await tx.orgSsoManagementIntent.findUnique({ where: { id: input.id } });
  if (!intent || intent.consumedAt || intent.expiresAt <= new Date() || intent.userId !== input.userId ||
    intent.credentialEpoch !== input.credentialEpoch || intent.clientDomain !== input.clientDomain ||
    intent.authenticationEvidenceId !== input.authenticationEvidenceId) refuse();
  const evidence = await requireAuthenticationEvidence({ id: intent.authenticationEvidenceId, userId: input.userId,
    credentialEpoch: input.credentialEpoch, clientDomain: input.clientDomain }, tx);
  const [user, org] = await Promise.all([
    tx.user.findUnique({ where: { id: input.userId }, select: { twoFaEnabled: true } }),
    tx.organisation.findUnique({ where: { id: intent.orgId }, select: { ownerId: true, lifecycleStatus: true } }),
  ]);
  if (!user || !org || org.ownerId !== input.userId || org.lifecycleStatus !== 'ACTIVE') withdrawn();
  if (evidence.provenance !== 'independent' || !evidence.authenticatedAt ||
    (user.twoFaEnabled && (!input.twoFaCompleted || !evidence.mfaCompletedAt))) refuse();
  const consumed = await tx.orgSsoManagementIntent.updateMany({ where: { id: intent.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) refuse();
  const proofUsed = await tx.authenticationEvidence.updateMany({ where: { id: evidence.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (proofUsed.count !== 1) refuse();
  const managementEvidence = await tx.authenticationEvidence.create({ data: {
    parentId: evidence.id, referenceHash: hashAssuranceReference(randomBytes(32).toString('base64url')),
    userId: evidence.userId, credentialEpoch: evidence.credentialEpoch, clientDomain: evidence.clientDomain,
    method: evidence.method, provenance: evidence.provenance, authenticatedAt: evidence.authenticatedAt,
    observedAt: evidence.observedAt, purpose: 'management', actionBinding: intent.id, browserHash: intent.browserHash,
    mfaCompletedAt: evidence.mfaCompletedAt, signatureCompletedAt: new Date(),
    consumedAt: new Date(), expiresAt: new Date(Math.min(evidence.expiresAt.getTime(), evidence.observedAt.getTime() + 600000)) } });
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Math.min(intent.expiresAt.getTime(), Date.now() + 120000));
  await tx.orgSsoManagementSession.create({ data: { tokenHash: hashAssuranceReference(token), userId: input.userId,
    credentialEpoch: input.credentialEpoch, clientDomain: input.clientDomain, orgId: intent.orgId,
    authenticationEvidenceId: managementEvidence.id, initiatingBrowserHash: intent.browserHash,
    authenticatedAt: evidence.observedAt, expiresAt } });
  return { status: 'management' as const, redirectTo: `${getPublicBaseUrl()}/auth/organisation-access#continuation=${token}` };
}
