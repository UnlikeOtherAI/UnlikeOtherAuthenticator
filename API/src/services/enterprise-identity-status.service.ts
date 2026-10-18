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
  userId: string, db: Pick<PrismaClient, 'scimResourceLink'>) {
  if (await db.scimResourceLink.findFirst({ where: { connectionId, resourceType: 'Users', subjectBinding: externalIdentityId,
    userId, OR: [{ active: false }, { deletedAt: { not: null } }] }, select: { id: true } })) {
    throw new AppError('FORBIDDEN', 403, 'SSO_IDENTITY_UNAVAILABLE');
  }
}
