import type { PrismaClient, RefreshToken, SessionAssurance } from '@prisma/client';
import { issueSessionAssurance, requireProductAssurance } from './session-assurance.service.js';
import { sealEnterpriseSecret } from './enterprise-secret.service.js';

/** Debug access is a child of the issuing session, never a new primary sign-in. */
export async function debugLoginSourceAssurance(source: RefreshToken, db: PrismaClient) {
  const user = await db.user.findUnique({ where: { id: source.userId }, select: { tokenVersion: true } });
  return requireProductAssurance({ id: source.assuranceId ?? undefined, userId: source.userId,
    clientDomain: source.domain, credentialEpoch: user?.tokenVersion ?? -1,
    orgId: source.orgId, teamId: source.teamId }, db);
}

export async function inheritDebugLoginAssurance(parent: SessionAssurance | null,
  child: { familyId: string; expiresAt: Date }, db: PrismaClient): Promise<void> {
  if (!parent) return;
  const issued = await issueSessionAssurance({ parentId: parent.id, userId: parent.userId,
    credentialEpoch: parent.credentialEpoch, clientDomain: parent.clientDomain,
    orgId: parent.orgId, teamId: parent.teamId, familyId: child.familyId,
    method: parent.method, connectionId: parent.connectionId,
    externalIdentityId: parent.externalIdentityId, connectionRevision: parent.connectionRevision,
    connectionGeneration: parent.connectionGeneration, policyGeneration: parent.policyGeneration,
    authenticatedAt: parent.authenticatedAt, observedAt: parent.observedAt,
    mfaSource: parent.mfaSource, amr: parent.amr, acr: parent.acr,
    expiresAt: new Date(Math.min(parent.expiresAt.getTime(), child.expiresAt.getTime())),
  }, db);
  await db.refreshToken.updateMany({ where: { familyId: child.familyId, userId: parent.userId,
    domain: parent.clientDomain, orgId: parent.orgId, teamId: parent.teamId }, data: {
    assuranceId: issued.assurance.id,
    encryptedAssuranceReference: await sealEnterpriseSecret(issued.reference, `assurance:${issued.assurance.id}`),
  } });
}
