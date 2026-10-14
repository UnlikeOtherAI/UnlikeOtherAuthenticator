import { Prisma, type PrismaClient, type DirectoryPermission } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { runInTransaction } from '../db/tenant-context.js';
import { assertProfileAuthority, type ProfileAuthority } from './profile.service.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';

async function owner(authority: ProfileAuthority, orgId: string, tx: PrismaClient) {
  await lockProductTeamPolicyExclusive(tx);
  await assertProfileAuthority(authority, tx, true);
  if (authority.claims.org?.org_id !== orgId) throw new AppError('FORBIDDEN', 403);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id=${orgId} FOR UPDATE`);
  const org = await tx.organisation.findUnique({ where: { id: orgId }, select: { ownerId: true, lifecycleStatus: true } });
  const member = await tx.orgMember.findUnique({ where: { orgId_userId: { orgId, userId: authority.claims.userId } }, select: { role: true, status: true } });
  if (authority.expiresAt <= Date.now() / 1000) throw new AppError('UNAUTHORIZED', 401);
  if (org?.lifecycleStatus !== 'ACTIVE' || org.ownerId !== authority.claims.userId || member?.status !== 'ACTIVE' || member.role !== 'owner') {
    throw new AppError('FORBIDDEN', 403);
  }
}
export async function listDirectoryGrants(authority: ProfileAuthority, orgId: string, prisma: PrismaClient) {
  return runInTransaction(prisma, async tx => {
    await owner(authority, orgId, tx);
    const rows = await tx.directoryOrganisationGrant.findMany({ where: { orgId },
      select: { id: true, credentialId: true, orgId: true, permissions: true, revokedAt: true,
        credential: { select: { label: true, clientDomainId: true, expiresAt: true, revokedAt: true } } },
      orderBy: { id: 'asc' }, take: 200 });
    return { data: rows };
  });
}
export async function setDirectoryGrant(authority: ProfileAuthority,
  input: { orgId: string; credentialId: string; permissions?: DirectoryPermission[]; revoke?: boolean }, prisma: PrismaClient) {
  return runInTransaction(prisma, async tx => {
    await owner(authority, input.orgId, tx);
    const credential = await tx.directoryCredential.findUnique({ where: { id: input.credentialId },
      select: { clientDomainId: true, expiresAt: true, revokedAt: true } });
    if (!input.revoke) {
      const domain = credential && await tx.clientDomain.findUnique({ where: { id: credential.clientDomainId }, select: { status: true } });
      if (!credential || credential.revokedAt || credential.expiresAt <= new Date() || domain?.status !== 'active') throw new AppError('NOT_FOUND', 404);
      const permissions = [...new Set(input.permissions ?? [])];
      if (!permissions.length || permissions.some(value => !['MEMBERSHIP_READ', 'DISPLAY_READ', 'WEBHOOK_MANAGE'].includes(value))) throw new AppError('BAD_REQUEST', 400);
      await tx.directoryOrganisationGrant.upsert({ where: { credentialId_orgId: { credentialId: input.credentialId, orgId: input.orgId } },
        create: { credentialId: input.credentialId, orgId: input.orgId, permissions, grantedByUserId: authority.claims.userId },
        update: { permissions, grantedByUserId: authority.claims.userId, revokedAt: null } });
    } else {
      await tx.directoryOrganisationGrant.updateMany({ where: { orgId: input.orgId, credentialId: input.credentialId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await tx.orgAuditLog.create({ data: { orgId: input.orgId, actorUserId: authority.claims.userId,
      action: input.revoke ? 'directory.grant_revoked' : 'directory.grant_updated', targetType: 'directory_credential', targetId: input.credentialId,
      metadata: { permissions: input.revoke ? [] : input.permissions ?? [] } } });
    return { ok: true };
  });
}
