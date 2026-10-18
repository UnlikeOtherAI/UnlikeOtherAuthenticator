import type { PrismaClient } from '@prisma/client';
import { requireAuthenticationEvidence } from './authentication-evidence.service.js';
import { AppError } from '../utils/errors.js';
import { hashRefreshToken } from './refresh-token-replay.service.js';
import { issueSessionAssurance, validateSessionAssurance } from './session-assurance.service.js';
import { sealEnterpriseSecret, openEnterpriseSecret } from './enterprise-secret.service.js';

export async function resolveTokenFamilyAssurance(params: {
  prisma: PrismaClient; userId: string; domain: string; refreshToken: string;
  sharedSecret: string; credentialEpoch: number; authenticationEvidenceId?: string;
}): Promise<{ assuranceId?: string; assuranceConnectionId?: string; assuranceRef?: string;
  assuranceExpiresAt?: string; globalAccountControl: boolean }> {
  const { prisma } = params;
  const product = await prisma.enterpriseProductReadiness.findUnique({ where: { clientDomain: params.domain } });
  const family = await prisma.refreshToken.findUnique({ where: {
    tokenHash: hashRefreshToken(params.refreshToken, params.sharedSecret),
  } });
  if (!family) throw new AppError('UNAUTHORIZED', 401, 'INVALID_SESSION_ASSURANCE');
  if (family.assuranceId) {
    const proof = await validateSessionAssurance({ id: family.assuranceId, userId: params.userId,
      clientDomain: params.domain, credentialEpoch: params.credentialEpoch,
      orgId: family.orgId, teamId: family.teamId }, prisma);
    if (!family.encryptedAssuranceReference) throw new AppError('UNAUTHORIZED', 401, 'INVALID_SESSION_ASSURANCE');
    return { assuranceRef: await openEnterpriseSecret(family.encryptedAssuranceReference, `assurance:${proof.id}`),
      assuranceId: proof.id, assuranceConnectionId: proof.connectionId ?? undefined,
      assuranceExpiresAt: proof.expiresAt.toISOString(), globalAccountControl: proof.method === 'independent' };
  }
  if (!product?.minimumAssuranceVersion && !params.authenticationEvidenceId) return { globalAccountControl: true };
  const evidence = await requireAuthenticationEvidence({ id: params.authenticationEvidenceId, userId: params.userId,
    credentialEpoch: params.credentialEpoch, clientDomain: params.domain }, prisma);
  if (!product?.minimumAssuranceVersion && evidence.provenance === 'independent') return { globalAccountControl: true };
  if (product?.minimumAssuranceVersion !== 1) throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
  if (!['independent', 'sso'].includes(evidence.provenance) || evidence.purpose !== 'authorize' || !evidence.signatureCompletedAt ||
    (evidence.provenance === 'sso' && (evidence.orgId !== family.orgId || (evidence.teamId && evidence.teamId !== family.teamId)))) {
    throw new AppError('FORBIDDEN', 403, 'INDEPENDENT_REAUTH_REQUIRED');
  }
  const policy = family.orgId ? await prisma.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: {
    clientDomain: family.domain, orgId: family.orgId,
  } } }) : null;
  const issued = await issueSessionAssurance({ userId: params.userId, credentialEpoch: params.credentialEpoch,
    clientDomain: family.domain, orgId: family.orgId, teamId: family.teamId, familyId: family.familyId,
    method: evidence.provenance, connectionId: evidence.connectionId, connectionRevision: evidence.connectionRevision,
    connectionGeneration: evidence.connectionGeneration, externalIdentityId: evidence.externalIdentityId, observedAt: evidence.observedAt, authenticatedAt: evidence.authenticatedAt,
    mfaSource: evidence.mfaCompletedAt ? 'uoa_totp' : evidence.provenance === 'sso' ? 'upstream_claimed' : 'none',
    amr: [...new Set([...evidence.amr, ...(evidence.mfaCompletedAt ? ['otp'] : [])])], acr: evidence.acr,
    policyGeneration: policy?.generation ?? 0, expiresAt: new Date(Math.min(family.expiresAt.getTime(),
      evidence.sessionDeadline?.getTime() ?? family.expiresAt.getTime())),
  }, prisma);
  const consumed = await prisma.authenticationEvidence.updateMany({ where: { id: evidence.id, consumedAt: null, revokedAt: null },
    data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_EVIDENCE_REQUIRED');
  const assuranceId = issued.assurance.id;
  await prisma.refreshToken.updateMany({ where: { familyId: family.familyId }, data: {
    assuranceId, encryptedAssuranceReference: await sealEnterpriseSecret(issued.reference, `assurance:${assuranceId}`),
  } });
  return { assuranceId, assuranceRef: issued.reference,
    assuranceExpiresAt: issued.assurance.expiresAt.toISOString(), assuranceConnectionId: evidence.connectionId ?? undefined,
    globalAccountControl: evidence.provenance === 'independent' };
}
