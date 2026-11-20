import { createHash, randomUUID } from 'node:crypto';
import { normalizeDomain } from '../utils/domain.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { lockEnterpriseOutbox } from './org-sso-revocation.service.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { Prisma, type PrismaClient, type ProductErasurePolicy } from '@prisma/client';
import { previewEntityDeletion } from './entity-deletion-preview.service.js';
import { AppError } from '../utils/errors.js';
import { markDeleting } from './entity-deletion-job.service.js';

export type Container = { scope: 'TEAM' | 'ORGANISATION'; id: string };
export async function containerOptions(tx: Prisma.TransactionClient, subject: string, policy: ProductErasurePolicy) {
  if (policy.mode !== 'ORGANISATION') return [];
  const orgs = await tx.organisation.findMany({
    where: { domain: { in: policy.domains }, lifecycleStatus: 'ACTIVE',
      members: { some: { userId: subject, status: 'ACTIVE' } } },
    select: { id: true, ownerId: true, name: true, allowedEmails: true, allowedEmailDomains: true, members: { where: { status: { not: 'REMOVED' } }, select: { userId: true } },
      teams: { select: { id: true, name: true, lifecycleStatus: true, allowedEmails: true, allowedEmailDomains: true,
        members: { where: { status: { not: 'REMOVED' } }, select: { userId: true, status: true } } } },
      invites: { where: { acceptedAt: null, declinedAt: null, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, take: 1 },
      inviteLinks: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, take: 1 } }, orderBy: { id: 'asc' },
  });
  const options: { scope: Container['scope']; id: string; name: string; digest: string; scopeDigest: string; teamIds: string[]; teamNames: string[]; retained: { reason: string; count: number }[] }[] = [];
  for (const org of orgs) {
    if (org.invites.length || org.inviteLinks.length || org.allowedEmails.length || org.allowedEmailDomains.length ||
        org.teams.some(team => team.allowedEmails.length || team.allowedEmailDomains.length)) continue;
    // Directory provisioning can repopulate apparently empty teams.
    if (await tx.orgSsoConnection.count({ where: { orgId: org.id } }) || await tx.organisationEmailDomain.count({ where: { orgId: org.id } })) continue;
    const ownTeams = org.teams.filter(t => t.members.some(m => m.userId === subject));
    if (ownTeams.length > 1) continue;
    const onlyPerson = org.ownerId === subject && org.members.every(m => m.userId === subject) &&
      org.teams.every(t => t.members.every(m => m.userId === subject));
    const targets: Container[] = onlyPerson ? [{ scope: 'ORGANISATION', id: org.id }] :
      ownTeams.length === 1 && ownTeams[0].members.length === 1 && ownTeams[0].members[0].status === 'ACTIVE' && ownTeams[0].lifecycleStatus === 'ACTIVE'
        ? [{ scope: 'TEAM', id: ownTeams[0].id }] : [];
    for (const target of targets) {
      const nativeDomain = normalizeDomain(getEnv().MCP_OAUTH_DOMAIN ?? '');
      if (nativeDomain) {
        const clients = await tx.oAuthClient.findMany({ where: { nativeApp: { identifier: { in: policy.nativeApps } } }, select: { clientId: true } });
        const external = await tx.refreshToken.count({ where: { ...(target.scope === 'TEAM' ? { teamId: target.id } : { orgId: target.id }),
          domain: nativeDomain, clientId: { notIn: clients.map(c => c.clientId) } } });
        if (external) continue;
      }
      const preview = await previewEntityDeletion(tx as PrismaClient, target.scope, target.id, 'ERASE_REFERENCE');
      if (preview.blockers.length || !preview.participants.length || preview.participants.some(p => !policy.domains.includes(p.domain)) ||
          preview.candidates.some(c => c.id !== subject)) continue;
      const teams = org.teams.filter(t => preview.teamIds.includes(t.id)).sort((a,b) => a.id.localeCompare(b.id));
      const retained = preview.retainedEvidence.filter(e => e.scope !== 'USER').map(({ reason, count }) => ({ reason, count }));
      // Erasing the product role can change orphan eligibility. No product request
      // ever deletes those users. Freeze the actual container, recipients and evidence.
      const scopeDigest = createHash('sha256').update(JSON.stringify([target, preview.name, teams.map(t => [t.id,t.name]),
        preview.participants, retained])).digest('hex');
      options.push({ ...target, name: preview.name, digest: preview.digest, scopeDigest, teamIds: teams.map(t => t.id), teamNames: teams.map(t => t.name), retained });
    }
  }
  return options;
}

// The product proof can never authorize a USER job or any orphan-account cascade.
async function beginOwnedContainerErasure(tx: Prisma.TransactionClient, target: Container, expectedDigest: string, subject: string) {
  const db = tx as PrismaClient;
  const preview = await previewEntityDeletion(db, target.scope, target.id, 'ERASE_REFERENCE');
  if (preview.digest !== expectedDigest || preview.blockers.length) throw new AppError('BAD_REQUEST', 409, 'DELETION_PREVIEW_CHANGED');
  preview.candidates = preview.candidates.map(c => ({ ...c, eligible: false, reasons: ['Product-only consent preserves the UOA identity'] }));
  await markDeleting(db, preview);
  const job = await tx.entityDeletionJob.create({ data: { scope: target.scope, targetId: target.id,
    mode: preview.mode, actorUserId: subject, requestKey: randomUUID(), status: 'WAITING_FOR_PRODUCTS',
    preview: preview as unknown as Prisma.InputJsonValue,
    participants: { create: preview.participants.map(({ clientDomainId, domain }) => ({ clientDomainId, domain })) } } });
  return job.id;
}

// Only a live platform administrator can promote the person's exact additional request
// into a shared-entity job, after reconciling dependencies outside UOA's inventory.
export async function reviewContainer(jobId: string, decision: 'approve' | 'preserve', actor: LifecycleActor) {
  return getAdminPrisma().$transaction(async tx => {
    await lockEnterpriseOutbox(tx);
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx as PrismaClient, actor);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM product_erasure_jobs WHERE id=${jobId} FOR UPDATE`);
    const job = await tx.productErasureJob.findUniqueOrThrow({ where: { id: jobId }, include: { policy: true } });
    const target = job.requestedContainer as (Container & { scopeDigest: string }) | null;
    if (job.containerJobId || !target) throw new AppError('BAD_REQUEST', 409, 'CONTAINER_REVIEW_CLOSED');
    await lockRefreshSessionUser(job.subject, { prisma: tx });
    if (decision === 'approve') {
      if (!job.policy.enabled || job.policy.revision !== job.revision) throw new AppError('BAD_REQUEST', 409, 'DELETION_POLICY_CHANGED');
      const row = await tx.user.findUnique({ where: { id: job.subject } });
      if (!row || row.lifecycleStatus !== 'ACTIVE' || (row.accountExpiresAt && row.accountExpiresAt <= new Date())) {
        throw new AppError('BAD_REQUEST', 409, 'ACCOUNT_UNAVAILABLE');
      }
      const options = await containerOptions(tx, job.subject, job.policy);
      const current = options.find(c => c.scope === target.scope && c.id === target.id && c.scopeDigest === target.scopeDigest);
      if (!current) throw new AppError('BAD_REQUEST', 409, 'DELETION_PREVIEW_CHANGED');
      const containerJobId = await beginOwnedContainerErasure(tx, current, current.digest, actor.userId);
      await tx.productErasureJob.update({ where: { id: jobId }, data: { containerJobId } });
    } else {
      const pending = await tx.productErasureReceipt.count({ where: { jobId, acknowledgedAt: null } });
      await tx.productErasureJob.update({ where: { id: jobId }, data: { requestedContainer: Prisma.DbNull, containerPreserved: true, completedAt: pending ? null : new Date() } });
    }
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'product.container_review', metadata: { jobId, decision, scope: target.scope, id: target.id } } });
    return { ok: true };
  }, { isolationLevel: 'Serializable', timeout: 15000 });
}
