import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

type IdentityStatusDb = Pick<PrismaClient, 'scimResourceLink' | 'externalIdentityTombstone'> | Pick<Prisma.TransactionClient, 'scimResourceLink' | 'externalIdentityTombstone'>;
export function enterpriseIdentityTupleHash(input: { connectionId: string; issuer: string; tenant: string; subject: string }): string {
  return createHash('sha256').update(JSON.stringify({ connectionId: input.connectionId,
    issuer: input.issuer, tenant: input.tenant, subject: input.subject })).digest('hex');
}
export async function assertEnterpriseIdentityNotErased(input: Parameters<typeof enterpriseIdentityTupleHash>[0], db: IdentityStatusDb) {
  if (await db.externalIdentityTombstone.findUnique({ where: { tupleHash: enterpriseIdentityTupleHash(input) }, select: { id: true } })) {
    throw new AppError('FORBIDDEN', 403, 'SSO_IDENTITY_UNAVAILABLE');
  }
}
/** A provisioner may deactivate only a previously reconciled stable identity. Pending mail hints do nothing. */
export async function assertEnterpriseProvisioningActive(connectionId: string, externalIdentityId: string,
  userId: string, db: Pick<PrismaClient, 'scimResourceLink' | 'externalIdentity' | 'organisationEmailDomain'>) {
  const identity = await db.externalIdentity.findFirst({ where: { id: externalIdentityId, connectionId, userId },
    select: { domainClaimId: true, clientDomain: true, orgId: true } });
  if (!identity) throw new AppError('FORBIDDEN', 403, 'SSO_IDENTITY_UNAVAILABLE');
  if (identity.domainClaimId && !await db.organisationEmailDomain.findFirst({ where: { id: identity.domainClaimId,
    clientDomain: identity.clientDomain, orgId: identity.orgId,
    status: 'VERIFIED', lastVerifiedAt: { gt: new Date(Date.now() - 86400000) } }, select: { id: true } })) {
    throw new AppError('FORBIDDEN', 403, 'SSO_IDENTITY_UNAVAILABLE');
  }
  if (await db.scimResourceLink.findFirst({ where: { connectionId, resourceType: 'Users', subjectBinding: externalIdentityId,
    userId, OR: [{ active: false }, { deletedAt: { not: null } }] }, select: { id: true } })) {
    throw new AppError('FORBIDDEN', 403, 'SSO_IDENTITY_UNAVAILABLE');
  }
}
