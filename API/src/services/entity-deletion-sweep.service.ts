import { type PrismaClient, type IdentityDeletionMode } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { DeletionPreview } from './entity-deletion-preview.service.js';
import { orphanEligibility, retainedEvidence } from './entity-deletion-preview.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';

export { scrubIdentityJson } from './identity-audit-sweep.service.js';
import { scrubOperationalAudits } from './identity-audit-sweep.service.js';
import { scrubOperatorAttribution } from './identity-operational-sweep.service.js';

export async function eraseOperationalIdentity(tx: PrismaClient, userId: string, mode: IdentityDeletionMode, auditsAlreadyScrubbed = false): Promise<void> {
  await lockRefreshSessionUser(userId, { prisma: tx });
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.lifecycleStatus === 'DELETED') return;
  if (await tx.organisation.count({ where: { ownerId: userId, lifecycleStatus: { not: 'DELETED' } } })) {
    throw new AppError('BAD_REQUEST', 409, 'OWNERSHIP_TRANSFER_REQUIRED');
  }
  const email = user.email;
  if (mode === 'RETAIN_REFERENCE') {
    const domains = new Set([
      ...(await tx.domainRole.findMany({ where: { userId }, select: { domain: true } })).map(r => r.domain),
      ...(await tx.loginLog.findMany({ where: { userId }, distinct: ['domain'], select: { domain: true } })).map(r => r.domain),
      ...(await tx.refreshToken.findMany({ where: { userId }, distinct: ['domain'], select: { domain: true } })).map(r => r.domain),
      ...(await tx.orgMember.findMany({ where: { userId }, select: { org: { select: { domain: true } } } })).map(r => r.org.domain),
      ...(await tx.agreementSignature.findMany({ where: { userId }, distinct: ['domain'], select: { domain: true } })).map(r => r.domain),
      ...(user.domain ? [user.domain] : []),
    ]);
    for (const access of await tx.billingServiceAccess.findMany({ where: { userId }, select: { appKey: { select: { actorIssuer: true } } } })) {
      const issuer = new URL(access.appKey.actorIssuer);
      if (issuer.protocol === 'https:' && issuer.pathname === '/' && !issuer.port && !issuer.username && !issuer.password) domains.add(issuer.hostname.toLowerCase());
    }
    await tx.historicalIdentityReference.createMany({ data: [...domains].map(domain => ({ userId, domain })), skipDuplicates: true });
  } else await tx.historicalIdentityReference.deleteMany({ where: { userId } });
  await tx.authorizationCode.deleteMany({ where: { userId } });
  await tx.verificationToken.deleteMany({ where: { OR: [{ userId }, ...(user.userKey ? [{ userKey: user.userKey }] : [])] } });
  await tx.refreshToken.deleteMany({ where: { userId } });
  await tx.nativeOAuthFlow.deleteMany({ where: { userId } });
  await tx.debugLoginGrant.deleteMany({ where: { userId } });
  await tx.authIdentity.deleteMany({ where: { userId } });
  await tx.userAvatar.deleteMany({ where: { userId } });
  await tx.userSetting.deleteMany({ where: { userId } });
  await tx.billingServiceAccess.deleteMany({ where: { userId } });
  await tx.signingContinuation.deleteMany({ where: { userId, claimIntents: { none: {} }, signatures: { none: {} } } });
  await tx.featureFlagUserOverride.deleteMany({ where: { userId } });
  await tx.groupMember.deleteMany({ where: { userId } });
  await tx.teamMember.deleteMany({ where: { userId } });
  await tx.orgMember.deleteMany({ where: { userId } });
  await tx.domainRole.deleteMany({ where: { userId } });
  await tx.loginLog.deleteMany({ where: { OR: [{ userId }, ...(email ? [{ userId: null, email: { equals: email, mode: 'insensitive' as const }, ...(user.domain ? { domain: user.domain } : {}) }] : [])] } });
  await tx.teamInvite.deleteMany({ where: { OR: [{ acceptedUserId: userId }, ...(email ? [{ email: { equals: email, mode: 'insensitive' as const }, team: { org: { ...(user.domain ? { domain: user.domain } : {}) } } }] : [])] } });
  await tx.teamInvite.updateMany({ where: { invitedByUserId: userId }, data: { invitedByUserId: null, invitedByName: null, invitedByEmail: null } });
  await tx.teamInvite.updateMany({ where: { requestedByUserId: userId }, data: { requestedByUserId: null } });
  await tx.teamInviteLink.updateMany({ where: { createdByUserId: userId }, data: { createdByUserId: null, revokedAt: new Date() } });
  await tx.accessRequest.deleteMany({ where: { OR: [{ userId }, ...(email ? [{ email: { equals: email, mode: 'insensitive' as const }, team: { org: { ...(user.domain ? { domain: user.domain } : {}) } } }] : [])] } });
  await tx.accessRequest.updateMany({ where: { reviewedByUserId: userId }, data: { reviewedByUserId: null, reviewReason: null } });
  await tx.ban.deleteMany({ where: { OR: [{ type: 'USER', value: userId }, ...(email ? [{ type: 'EMAIL' as const, value: { equals: email, mode: 'insensitive' as const } }] : [])] } });
  if (email) {
    await tx.ban.updateMany({ where: { createdByEmail: { equals: email, mode: 'insensitive' } }, data: { createdByEmail: null } });
  }
  await scrubOperatorAttribution(tx, user, mode === 'ERASE_REFERENCE');
  if (!auditsAlreadyScrubbed) await scrubOperationalAudits(tx, user, mode === 'ERASE_REFERENCE');
  const protectedRows = await retainedEvidence(tx, 'USER', userId);
  await tx.user.update({ where: { id: userId }, data: {
    lifecycleStatus: 'DELETED', lifecycleChangedAt: new Date(), email: null, userKey: null, name: null,
    passwordHash: null, twoFaEnabled: false, twoFaSecret: null, twoFaLastAcceptedCounter: null,
    avatarUrl: null, tokenVersion: { increment: 1 }, lifecycleReason: null, lifecycleInternalNote: null,
    lifecycleTemplateId: null, lifecycleTemplateRevision: null,
  } });
  if (mode === 'ERASE_REFERENCE' && protectedRows.length === 0) await tx.user.delete({ where: { id: userId } });
}

export async function sweepDeletion(tx: PrismaClient, preview: DeletionPreview, eraseAccounts = true): Promise<void> {
  if (preview.scope === 'USER') { if (eraseAccounts) await eraseOperationalIdentity(tx, preview.targetId, preview.mode); return; }
  const orgId = preview.organisationId;
  if (!orgId) throw new AppError('INTERNAL', 500, 'DELETION_SCOPE_MISSING');
  const deleteOrg = preview.effectiveScope === 'ORGANISATION';
  const teamIds = preview.teamIds;
  const teamWhere = { teamId: { in: teamIds } };
  await tx.teamInvite.deleteMany({ where: teamWhere });
  await tx.teamInviteLink.deleteMany({ where: teamWhere });
  await tx.accessRequest.deleteMany({ where: teamWhere });
  await tx.teamAvatar.deleteMany({ where: teamWhere });
  await tx.ban.deleteMany({ where: teamWhere });
  await tx.billingServiceAccess.deleteMany({ where: teamWhere });
  // Eligibility is frozen by the exclusive product lock plus canonical user locks at execution.
  const eligibility = await Promise.all(preview.candidates.filter(c => c.eligible).map(c => c.id).sort()
    .map(userId => orphanEligibility(tx, userId, orgId, teamIds, deleteOrg, true)));
  if (eligibility.some(c => !c.eligible)) throw new AppError('BAD_REQUEST', 409, 'DELETION_CANDIDATE_DEPENDENCY_CHANGED');
  await tx.teamMember.deleteMany({ where: teamWhere });
  await tx.debugLoginGrant.deleteMany({ where: teamWhere });
  await tx.authorizationCode.deleteMany({ where: teamWhere });
  await tx.refreshToken.deleteMany({ where: teamWhere });
  if (!deleteOrg) {
    // The default workspace remains unique even when its old row is retained as evidence.
    await tx.team.updateMany({ where: { id: { in: teamIds }, lifecycleStatus: { not: 'DELETED' } }, data: { isDefault: false } });
    const replacement = await tx.team.findFirst({ where: { orgId, id: { notIn: teamIds }, lifecycleStatus: { in: ['ACTIVE', 'DISABLED'] } }, orderBy: { id: 'asc' } });
    if (replacement && !await tx.team.count({ where: { orgId, isDefault: true, id: { notIn: teamIds } } })) await tx.team.update({ where: { id: replacement.id }, data: { isDefault: true } });
    for (const candidate of eligibility.filter(c => c.eligible)) await tx.orgMember.deleteMany({ where: { orgId, userId: candidate.id } });
  }
  if (deleteOrg) {
    await tx.orgMember.deleteMany({ where: { orgId } });
    await tx.group.deleteMany({ where: { orgId } });
    await tx.ban.deleteMany({ where: { orgId } });
    await tx.app.deleteMany({ where: { orgId } });
    await tx.orgAuditLog.deleteMany({ where: { orgId } });
    await tx.organisation.update({ where: { id: orgId }, data: { ownerId: null } });
  }
  for (const teamId of teamIds) {
    if ((await tx.team.findUnique({ where: { id: teamId }, select: { lifecycleStatus: true } }))?.lifecycleStatus === 'DELETED') continue;
    const retained = await retainedEvidence(tx, 'TEAM', teamId);
    if (!retained.length) await tx.team.delete({ where: { id: teamId } });
    else await tx.team.update({ where: { id: teamId }, data: { lifecycleStatus: 'DELETED', name: `Deleted team ${teamId}`, slug: `deleted-${teamId}`, groupId: null, description: null, iconUrl: null, allowedEmails: [], allowedEmailDomains: [], lifecycleReason: null, lifecycleInternalNote: null, lifecycleTemplateId: null, lifecycleTemplateRevision: null } });
  }
  if (deleteOrg) {
    const retained = await retainedEvidence(tx, 'ORGANISATION', orgId);
    if (!retained.length && !await tx.team.count({ where: { orgId } })) await tx.organisation.delete({ where: { id: orgId } });
    else await tx.organisation.update({ where: { id: orgId }, data: { lifecycleStatus: 'DELETED', name: 'Deleted organisation', slug: `deleted-${orgId}`, iconUrl: null, allowedEmails: [], allowedEmailDomains: [], lifecycleReason: null, lifecycleInternalNote: null, lifecycleTemplateId: null, lifecycleTemplateRevision: null } });
  }
  for (const candidate of eligibility) {
    if (eraseAccounts && candidate.eligible) await eraseOperationalIdentity(tx, candidate.id, preview.mode);
  }
}
