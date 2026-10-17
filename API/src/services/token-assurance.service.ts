import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { hashRefreshToken } from './refresh-token-replay.service.js';
import { issueSessionAssurance, validateSessionAssurance } from './session-assurance.service.js';
import { sealEnterpriseSecret, openEnterpriseSecret } from './enterprise-secret.service.js';

export async function resolveTokenFamilyAssurance(params: {
  prisma: PrismaClient; userId: string; domain: string; refreshToken: string;
  sharedSecret: string; credentialEpoch: number; independentAuthenticatedAt?: Date;
}): Promise<{ assuranceId?: string; assuranceConnectionId?: string; assuranceRef?: string;
  assuranceExpiresAt?: string; globalAccountControl: boolean }> {
  const { prisma } = params;
  const product = await prisma.enterpriseProductReadiness.findUnique({ where: { clientDomain: params.domain } });
  if (!product?.minimumAssuranceVersion) return { globalAccountControl: true };
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
  if (!params.independentAuthenticatedAt) throw new AppError('FORBIDDEN', 403, 'INDEPENDENT_REAUTH_REQUIRED');
  const policy = family.orgId ? await prisma.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: {
    clientDomain: family.domain, orgId: family.orgId,
  } } }) : null;
  const issued = await issueSessionAssurance({ userId: params.userId, credentialEpoch: params.credentialEpoch,
    clientDomain: family.domain, orgId: family.orgId, teamId: family.teamId, familyId: family.familyId,
    method: 'independent', observedAt: params.independentAuthenticatedAt, authenticatedAt: params.independentAuthenticatedAt,
    mfaSource: family.twoFaCompleted ? 'uoa_totp' : 'none', amr: family.twoFaCompleted ? ['independent', 'otp'] : ['independent'],
    policyGeneration: policy?.generation ?? 0, expiresAt: family.expiresAt,
  }, prisma);
  const assuranceId = issued.assurance.id;
  await prisma.refreshToken.updateMany({ where: { familyId: family.familyId }, data: {
    assuranceId, encryptedAssuranceReference: await sealEnterpriseSecret(issued.reference, `assurance:${assuranceId}`),
  } });
  return { assuranceId, assuranceRef: issued.reference,
    assuranceExpiresAt: issued.assurance.expiresAt.toISOString(), globalAccountControl: true };
}
