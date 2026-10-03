import { createHash, randomUUID } from 'node:crypto';
import { scrubOperationalAuditsBatch, type AuditProgress } from './identity-audit-sweep.service.js';
import { Prisma, type LifecycleScope, type IdentityDeletionMode, type PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { previewEntityDeletion, type DeletionPreview } from './entity-deletion-preview.service.js';
import { sweepDeletion, eraseOperationalIdentity } from './entity-deletion-sweep.service.js';
import { lockProductTeamPolicyExclusive, lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { verifyDomainAuthToken } from './domain-secret.service.js';
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
      if (previous.scope !== params.scope || (previous.targetId !== params.id && previous.targetId !== 'erased:' + targetDigest(params.id)) || previous.mode !== params.mode) throw new AppError('BAD_REQUEST', 409, 'DELETION_RETRY_MISMATCH');
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

type Progress = { scopeCleaned: boolean; usersDone: string[]; audit?: AuditProgress };
const targetDigest = (id: string) => createHash('sha256').update(id).digest('hex');

export async function executeEntityDeletion(id: string, actor: LifecycleActor) {
  const leaseOwner = randomUUID(), prisma = getAdminPrisma();
  let job = await prisma.$transaction(async tx => {
    const client = tx as unknown as PrismaClient;
    await requireLifecycleActor(client, actor);
    await client.$queryRaw(Prisma.sql`SELECT id FROM entity_deletion_jobs WHERE id=${id} FOR UPDATE`);
    const row = await client.entityDeletionJob.findUnique({ where: { id }, include: { participants: true } });
    if (!row) throw new AppError('NOT_FOUND', 404);
    if (row.status === 'COMPLETE') return row;
    if (row.participants.some(p => !p.acknowledgedAt)) throw new AppError('BAD_REQUEST', 409, 'DELETION_PRODUCTS_PENDING');
    if (row.leaseExpiresAt && row.leaseExpiresAt > new Date()) throw new AppError('BAD_REQUEST', 409, 'DELETION_ALREADY_RUNNING');
    return client.entityDeletionJob.update({ where: { id }, data: { leaseOwner, leaseExpiresAt: new Date(Date.now() + 120_000), status: 'READY', blockers: [] }, include: { participants: true } });
  });
  if (job.status === 'COMPLETE') return job;
  const preview = job.preview as unknown as DeletionPreview;
  const committedUsers = preview.scope === 'USER' ? [preview.targetId] : preview.candidates.filter(c => c.eligible).map(c => c.id).sort();
  try {
    // Every stage commits its cursor with its effects. No all-auth policy lock is held during cleanup.
    for (let stage = 0; stage < 20; stage++) {
      job = await prisma.$transaction(async tx => {
        const client = tx as unknown as PrismaClient;
        const actorEmail = await requireLifecycleActor(client, actor);
        await client.$queryRaw(Prisma.sql`SELECT id FROM entity_deletion_jobs WHERE id=${id} FOR UPDATE`);
        const current = await client.entityDeletionJob.findUniqueOrThrow({ where: { id } });
        if (current.leaseOwner !== leaseOwner) throw new AppError('BAD_REQUEST', 409, 'DELETION_LEASE_CHANGED');
        const progress = { scopeCleaned: false, usersDone: [], ...current.progress as unknown as Partial<Progress> } as Progress;
        if (!progress.scopeCleaned) {
          for (const userId of committedUsers) {
            await lockRefreshSessionUser(userId, { prisma: client });
            await client.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id=${userId} FOR UPDATE`);
          }
          await sweepDeletion(client, preview, false);
          progress.scopeCleaned = true;
        } else {
          const userId = committedUsers.find(subject => !progress.usersDone.includes(subject));
          if (userId) {
            await lockRefreshSessionUser(userId, { prisma: client });
            const user = await client.user.findUnique({ where: { id: userId } });
            if (!user || user.lifecycleStatus === 'DELETED') { progress.usersDone.push(userId); delete progress.audit; }
            else {
              progress.audit = await scrubOperationalAuditsBatch(client, user, preview.mode === 'ERASE_REFERENCE', progress.audit);
              if (progress.audit.complete) {
                await eraseOperationalIdentity(client, userId, preview.mode, true);
                progress.usersDone.push(userId); delete progress.audit;
              }
            }
          } else {
            const erased = preview.mode === 'ERASE_REFERENCE';
            const finalPreview = { ...preview, name: preview.scope === 'USER' ? 'Deleted user' : preview.scope === 'TEAM' ? 'Deleted team' : 'Deleted organisation',
              ...(erased ? { targetId: preview.scope === 'USER' ? null : preview.targetId,
                effectiveTargetId: preview.scope === 'USER' ? null : preview.effectiveTargetId,
                candidates: [], confirmation: '', digest: '', receiptTargetDigest: targetDigest(preview.targetId) } : {}) };
            await client.adminAuditLog.create({ data: { actorEmail, action: 'entity.deletion_completed', metadata: { jobId: id, retainedEvidence: preview.retainedEvidence as unknown as Prisma.InputJsonValue } } });
            return client.entityDeletionJob.update({ where: { id }, data: { status: 'COMPLETE', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null,
              ...(erased && preview.scope === 'USER' ? { targetId: 'erased:' + targetDigest(preview.targetId) } : {}),
              preview: finalPreview as unknown as Prisma.InputJsonValue, progress: { scopeCleaned: true, accountsCompleted: committedUsers.length }, blockers: [] }, include: { participants: true } });
          }
        }
        return client.entityDeletionJob.update({ where: { id }, data: { progress: progress as unknown as Prisma.InputJsonValue, leaseExpiresAt: new Date(Date.now() + 120_000) }, include: { participants: true } });
      }, { timeout: 15_000 });
      if (job.status === 'COMPLETE') return job;
    }
    await prisma.entityDeletionJob.updateMany({ where: { id, leaseOwner }, data: { leaseOwner: null, leaseExpiresAt: null } });
  } catch (error) {
    // Store bounded operational diagnostics, never profile values or database error text.
    await prisma.entityDeletionJob.updateMany({ where: { id, leaseOwner }, data: { status: 'BLOCKED', leaseOwner: null, leaseExpiresAt: null,
      blockers: [error instanceof AppError ? error.message : 'Local cleanup failed; retry after resolving the operational blocker.'] } });
    throw error;
  }
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
  retainedEvidence?: { label: string; count: number; reason: string }[];
  authority?: { domain: string; token: string };
}) {
  return runInTransaction(getAdminPrisma(), async tx => {
    await lockProductTeamPolicyShared(tx);
    if (params.authority) {
      const authority = await verifyDomainAuthToken(params.authority, { prisma: tx });
      if (authority.clientDomainId !== params.clientDomainId) throw new AppError('UNAUTHORIZED', 401);
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM entity_deletion_jobs WHERE id=${params.jobId} FOR UPDATE`);
    const participant = await tx.entityDeletionParticipant.findUnique({ where: { jobId_clientDomainId: { jobId: params.jobId, clientDomainId: params.clientDomainId } }, include: { job: true } });
    if (!participant || participant.job.revision !== params.revision) throw new AppError('NOT_FOUND', 404);
    if (participant.acknowledgedAt) {
      if (participant.outcome !== params.outcome || JSON.stringify(participant.retainedEvidence) !== JSON.stringify(params.retainedEvidence ?? [])) throw new AppError('BAD_REQUEST', 409, 'DELETION_ACK_MISMATCH');
      return { ok: true };
    }
    await tx.entityDeletionParticipant.update({ where: { id: participant.id }, data: { acknowledgedAt: new Date(), outcome: params.outcome, retainedEvidence: params.retainedEvidence ?? [] } });
    const remaining = await tx.entityDeletionParticipant.count({ where: { jobId: params.jobId, acknowledgedAt: null } });
    if (!remaining) await tx.entityDeletionJob.update({ where: { id: params.jobId }, data: { status: 'READY' } });
    return { ok: true };
  });
}
