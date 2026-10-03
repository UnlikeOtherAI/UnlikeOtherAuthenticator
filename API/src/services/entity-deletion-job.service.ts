import { Prisma, type LifecycleScope, type IdentityDeletionMode, type PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { previewEntityDeletion, type DeletionPreview } from './entity-deletion-preview.service.js';
import { sweepDeletion } from './entity-deletion-sweep.service.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { lifecycleTarget, protectLastAdmin, requireLifecycleActor, revokeLifecycleSessions, type LifecycleActor } from './internal-admin-lifecycle.service.js';

export async function getDeletionPreview(scope: LifecycleScope, id: string, mode: IdentityDeletionMode) {
  return previewEntityDeletion(getAdminPrisma(), scope, id, mode);
}

async function markDeleting(tx: PrismaClient, preview: DeletionPreview) {
  const data = { lifecycleStatus: 'DELETING' as const, lifecycleChangedAt: new Date() };
  if (preview.scope === 'USER') {
    await protectLastAdmin(tx, preview.targetId);
    await lockRefreshSessionUser(preview.targetId, { prisma: tx });
    await tx.user.update({ where: { id: preview.targetId }, data });
  } else {
    await tx.team.updateMany({ where: { id: { in: preview.teamIds } }, data });
    if (preview.effectiveScope === 'ORGANISATION') await tx.organisation.update({ where: { id: preview.effectiveTargetId }, data });
    for (const candidate of preview.candidates.filter(c => c.eligible)) {
      await lockRefreshSessionUser(candidate.id, { prisma: tx });
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id=${candidate.id} FOR UPDATE`);
      await tx.user.update({ where: { id: candidate.id }, data });
      await revokeLifecycleSessions(tx, 'USER', candidate.id);
    }
  }
  await revokeLifecycleSessions(tx, preview.effectiveScope, preview.effectiveTargetId);
}

export async function beginEntityDeletion(params: {
  scope: LifecycleScope; id: string; mode: IdentityDeletionMode; previewDigest: string;
  confirmation: string; requestKey: string; actor: LifecycleActor;
}) {
  return runInTransaction(getAdminPrisma(), async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx, params.actor);
    const previous = await tx.entityDeletionJob.findUnique({ where: { requestKey: params.requestKey }, include: { participants: true } });
    if (previous) {
      if (previous.scope !== params.scope || previous.targetId !== params.id || previous.mode !== params.mode) throw new AppError('BAD_REQUEST', 409, 'DELETION_RETRY_MISMATCH');
      return previous;
    }
    const current = await lifecycleTarget(tx, params.scope, params.id);
    if (['DELETING', 'DELETED'].includes(current.lifecycleStatus)) throw new AppError('BAD_REQUEST', 409, 'ENTITY_TERMINAL');
    const preliminary = await previewEntityDeletion(tx, params.scope, params.id, params.mode);
    for (const userId of (params.scope === 'USER' ? [params.id] : preliminary.candidates.map(c => c.id)).sort()) {
      await lockRefreshSessionUser(userId, { prisma: tx });
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id=${userId} FOR UPDATE`);
    }
    if (preliminary.organisationId) await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id=${preliminary.organisationId} FOR UPDATE`);
    for (const teamId of preliminary.teamIds) await tx.$queryRaw(Prisma.sql`SELECT id FROM teams WHERE id=${teamId} FOR UPDATE`);
    const preview = await previewEntityDeletion(tx, params.scope, params.id, params.mode);
    if (params.confirmation !== preview.confirmation || params.previewDigest !== preview.digest) throw new AppError('BAD_REQUEST', 409, 'DELETION_PREVIEW_CHANGED');
    if (preview.blockers.length) throw new AppError('BAD_REQUEST', 409, 'DELETION_BLOCKED');
    await markDeleting(tx, preview);
    const job = await tx.entityDeletionJob.create({ data: {
      scope: params.scope, targetId: params.id, mode: params.mode, requestKey: params.requestKey,
      actorUserId: params.actor.userId, status: preview.participants.length ? 'WAITING_FOR_PRODUCTS' : 'READY',
      preview: preview as unknown as Prisma.InputJsonValue,
      participants: { create: preview.participants.map(p => ({ clientDomainId: p.clientDomainId, domain: p.domain })) },
    }, include: { participants: true } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'entity.deletion_started', metadata: { jobId: job.id, scope: params.scope, targetId: params.id, mode: params.mode } } });
    return job;
  });
}

export async function getDeletionJob(id: string) {
  const job = await getAdminPrisma().entityDeletionJob.findUnique({ where: { id }, include: { participants: true } });
  if (!job) throw new AppError('NOT_FOUND', 404);
  return job;
}

export async function executeEntityDeletion(id: string, actor: LifecycleActor) {
  await runInTransaction(getAdminPrisma(), async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx, actor);
    const job = await tx.entityDeletionJob.findUnique({ where: { id }, include: { participants: true } });
    if (!job) throw new AppError('NOT_FOUND', 404);
    if (job.status === 'COMPLETE') return;
    if (job.participants.some(p => !p.acknowledgedAt)) throw new AppError('BAD_REQUEST', 409, 'DELETION_PRODUCTS_PENDING');
    const preview = job.preview as unknown as DeletionPreview;
    const userIds = preview.scope === 'USER' ? [preview.targetId] : preview.candidates.map(c => c.id);
    for (const userId of [...userIds].sort()) {
      await lockRefreshSessionUser(userId, { prisma: tx });
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id=${userId} FOR UPDATE`);
    }
    // Container locks prevent a newly inserted team or membership escaping the cascade.
    if (preview.organisationId) await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id=${preview.organisationId} FOR UPDATE`);
    for (const teamId of preview.teamIds) await tx.$queryRaw(Prisma.sql`SELECT id FROM teams WHERE id=${teamId} FOR UPDATE`);
    await sweepDeletion(tx, preview);
    await tx.entityDeletionJob.update({ where: { id }, data: {
      status: 'COMPLETE', completedAt: new Date(), blockers: [],
      preview: { ...preview, name: preview.scope === 'USER' ? 'Deleted user' : preview.name } as unknown as Prisma.InputJsonValue,
    } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'entity.deletion_completed', metadata: { jobId: id, retainedEvidence: preview.retainedEvidence as unknown as Prisma.InputJsonValue } } });
  });
  return getDeletionJob(id);
}

export async function productDeletionJobs(clientDomainId: string) {
  const rows = await getAdminPrisma().entityDeletionParticipant.findMany({ where: {
    clientDomainId, acknowledgedAt: null, job: { status: { not: 'COMPLETE' } },
  }, include: { job: true }, take: 100, orderBy: { id: 'asc' } });
  return rows.map(p => {
    const preview = p.job.preview as unknown as DeletionPreview;
    return { id: p.job.id, revision: p.job.revision, scope: p.job.scope, targetId: p.job.targetId,
      mode: p.job.mode, organisationId: preview.organisationId, teamIds: preview.teamIds,
      effectiveScope: preview.effectiveScope, effectiveTargetId: preview.effectiveTargetId,
      accountsToDelete: preview.scope === 'USER' ? [preview.targetId] : preview.candidates.filter(c => c.eligible).map(c => c.id) };
  });
}

export async function acknowledgeProductDeletion(params: {
  clientDomainId: string; jobId: string; revision: number; outcome: 'PURGED' | 'RETAINED_EVIDENCE';
}) {
  return runInTransaction(getAdminPrisma(), async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM entity_deletion_jobs WHERE id=${params.jobId} FOR UPDATE`);
    const participant = await tx.entityDeletionParticipant.findUnique({ where: { jobId_clientDomainId: { jobId: params.jobId, clientDomainId: params.clientDomainId } }, include: { job: true } });
    if (!participant || participant.job.revision !== params.revision) throw new AppError('NOT_FOUND', 404);
    if (participant.acknowledgedAt) {
      if (participant.outcome !== params.outcome) throw new AppError('BAD_REQUEST', 409, 'DELETION_ACK_MISMATCH');
      return { ok: true };
    }
    await tx.entityDeletionParticipant.update({ where: { id: participant.id }, data: { acknowledgedAt: new Date(), outcome: params.outcome } });
    const remaining = await tx.entityDeletionParticipant.count({ where: { jobId: params.jobId, acknowledgedAt: null } });
    if (!remaining) await tx.entityDeletionJob.update({ where: { id: params.jobId }, data: { status: 'READY' } });
    return { ok: true };
  });
}
