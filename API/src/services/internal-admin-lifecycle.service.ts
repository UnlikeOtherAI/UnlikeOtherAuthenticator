import { Prisma, type PrismaClient, type LifecycleScope } from '@prisma/client';
import { getAdminAuthDomain } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';

export type LifecycleActor = { userId: string; tokenVersion: number };
export async function requireLifecycleActor(tx: PrismaClient, actor: LifecycleActor): Promise<string> {
  await lockRefreshSessionUser(actor.userId, { prisma: tx });
  await tx.$queryRaw(Prisma.sql`SELECT user_id FROM domain_roles WHERE user_id=${actor.userId} AND domain=${getAdminAuthDomain()} FOR SHARE`);
  const user = await tx.user.findUnique({ where: { id: actor.userId } });
  const role = await tx.domainRole.findUnique({ where: { domain_userId: { domain: getAdminAuthDomain(), userId: actor.userId } } });
  if (!user || !user.email || user.lifecycleStatus !== 'ACTIVE' || user.tokenVersion !== actor.tokenVersion || role?.role !== 'SUPERUSER') {
    throw new AppError('FORBIDDEN', 403);
  }
  return user.email;
}

export async function lifecycleTarget(tx: PrismaClient, scope: LifecycleScope, id: string) {
  const row = scope === 'USER' ? await tx.user.findUnique({ where: { id } })
    : scope === 'TEAM' ? await tx.team.findUnique({ where: { id } })
      : await tx.organisation.findUnique({ where: { id } });
  if (!row) throw new AppError('NOT_FOUND', 404);
  return row;
}

export async function protectLastAdmin(tx: PrismaClient, userId: string): Promise<void> {
  const role = await tx.domainRole.findUnique({ where: { domain_userId: { domain: getAdminAuthDomain(), userId } } });
  if (role?.role === 'SUPERUSER' && await tx.domainRole.count({ where: {
    domain: getAdminAuthDomain(), role: 'SUPERUSER', userId: { not: userId }, user: { lifecycleStatus: 'ACTIVE' },
  } }) === 0) throw new AppError('BAD_REQUEST', 409, 'LAST_ACTIVE_PLATFORM_ADMIN');
}

export async function revokeLifecycleSessions(tx: PrismaClient, scope: LifecycleScope, id: string): Promise<void> {
  if (scope === 'USER') {
    await tx.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });
    await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.authorizationCode.deleteMany({ where: { userId: id } });
    await tx.verificationToken.deleteMany({ where: { userId: id } });
    return;
  }
  const memberships = scope === 'TEAM'
    ? await tx.teamMember.findMany({ where: { teamId: id }, select: { userId: true } })
    : await tx.orgMember.findMany({ where: { orgId: id }, select: { userId: true } });
  for (const userId of [...new Set(memberships.map(m => m.userId))].sort()) {
    await lockRefreshSessionUser(userId, { prisma: tx });
  }
  const scopeWhere = scope === 'TEAM' ? { teamId: id } : { orgId: id };
  await tx.refreshToken.updateMany({ where: { ...scopeWhere, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.authorizationCode.deleteMany({ where: scopeWhere });
  if (scope === 'ORGANISATION') {
    const org = await tx.organisation.findUniqueOrThrow({ where: { id }, select: { domain: true } });
    const userIds = memberships.map(m => m.userId);
    // Before scoped sessions existed, origin-domain rows were attributable only to this
    // user's one active organisation in that domain. Retire that legacy authority explicitly.
    await tx.refreshToken.updateMany({ where: { userId: { in: userIds }, domain: org.domain, orgId: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.authorizationCode.deleteMany({ where: { userId: { in: userIds }, domain: org.domain, orgId: null } });
  }
}

export async function getEntityLifecycle(scope: LifecycleScope, id: string) {
  const row = await lifecycleTarget(getAdminPrisma(), scope, id);
  const job = await getAdminPrisma().entityDeletionJob.findUnique({ where: { scope_targetId: { scope, targetId: id } }, select: { id: true, status: true } });
  return { scope, id, status: row.lifecycleStatus, changedAt: row.lifecycleChangedAt,
    reason: row.lifecycleReason, internalNote: row.lifecycleInternalNote,
    templateId: row.lifecycleTemplateId, templateRevision: row.lifecycleTemplateRevision,
    deleted: row.lifecycleStatus === 'DELETED', deletionJobId: job?.id ?? null, deletionJobStatus: job?.status ?? null };
}

export async function setEntityLifecycle(params: {
  scope: LifecycleScope; id: string; status: 'ACTIVE' | 'DISABLED';
  templateId?: string; templateRevision?: number; internalNote?: string; actor: LifecycleActor;
}) {
  const prisma = getAdminPrisma();
  await runInTransaction(prisma, async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx, params.actor);
    const row = await lifecycleTarget(tx, params.scope, params.id);
    if (row.lifecycleStatus === 'DELETING' || row.lifecycleStatus === 'DELETED') throw new AppError('BAD_REQUEST', 409, 'ENTITY_TERMINAL');
    if (params.status === 'DISABLED' && params.scope === 'USER') await protectLastAdmin(tx, params.id);
    const template = params.templateId ? await tx.lifecycleReasonTemplate.findUnique({ where: { id: params.templateId } }) : null;
    if (params.status === 'DISABLED' && (!template || !template.enabled || template.scope !== params.scope || template.revision !== params.templateRevision)) {
      throw new AppError('BAD_REQUEST', 409, 'LIFECYCLE_TEMPLATE_CHANGED');
    }
    if (params.scope === 'USER') await lockRefreshSessionUser(params.id, { prisma: tx });
    const data = { lifecycleStatus: params.status, lifecycleChangedAt: new Date(),
      lifecycleReason: params.status === 'DISABLED' ? template?.message ?? null : null,
      lifecycleTemplateId: params.status === 'DISABLED' ? template?.id ?? null : null,
      lifecycleTemplateRevision: params.status === 'DISABLED' ? template?.revision ?? null : null,
      lifecycleInternalNote: params.internalNote ?? null };
    if (params.scope === 'USER') await tx.user.update({ where: { id: params.id }, data });
    else if (params.scope === 'TEAM') await tx.team.update({ where: { id: params.id }, data });
    else await tx.organisation.update({ where: { id: params.id }, data });
    if (params.status === 'DISABLED') await revokeLifecycleSessions(tx, params.scope, params.id);
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'entity.lifecycle_changed',
      metadata: { scope: params.scope, id: params.id, status: params.status, templateId: template?.id, templateRevision: template?.revision } as Prisma.InputJsonValue } });
  });
  return getEntityLifecycle(params.scope, params.id);
}

export async function saveLifecycleTemplate(params: {
  id?: string; scope: LifecycleScope; title: string; message: string; enabled: boolean; actor: LifecycleActor;
}) {
  return runInTransaction(getAdminPrisma(), async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx, params.actor);
    const data = { scope: params.scope, title: params.title, message: params.message, enabled: params.enabled };
    const template = params.id ? await tx.lifecycleReasonTemplate.update({ where: { id: params.id }, data: { ...data, revision: { increment: 1 } } })
      : await tx.lifecycleReasonTemplate.create({ data });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'lifecycle.template_saved', metadata: { id: template.id, revision: template.revision } } });
    return template;
  });
}
