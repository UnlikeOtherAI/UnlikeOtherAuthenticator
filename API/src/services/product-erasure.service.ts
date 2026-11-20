import { containerOptions, type Container } from './product-erasure-containers.service.js';
import { revokeEnterpriseScope } from './org-sso-revocation.service.js';
import { createHash } from 'node:crypto';
import { Prisma, type ProductErasurePolicy, type PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { verifyDomainAuthToken } from './domain-secret.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';

type Db = Prisma.TransactionClient;
export async function enabledProduct(db: Db, id: string) {
  const policy = await db.productErasurePolicy.findUnique({ where: { id } });
  if (!policy?.enabled || policy.domains.includes(getAdminAuthDomain()) ||
      policy.domains.includes(normalizeDomain(getEnv().MCP_OAUTH_DOMAIN ?? ''))) throw new AppError('NOT_FOUND', 404, 'PRODUCT_ERASURE_UNAVAILABLE');
  return policy;
}

// Include historical participation and suspended people. A shared product may see teams
// founded under a different domain, so origin domain alone cannot identify its footprint.
export async function productImpact(db: Db, subject: string, policy: ProductErasurePolicy) {
  const accesses = await db.billingServiceAccess.findMany({ where: { userId: subject,
    appKey: { actorIssuer: { in: policy.domains.map(domain => 'https://' + domain) } } }, select: { orgId: true } });
  const orgs = policy.mode === 'ORGANISATION' ? await db.organisation.findMany({
    where: { OR: [{ id: { in: accesses.map(a => a.orgId) } }, { domain: { in: policy.domains },
      OR: [{ ownerId: subject }, { members: { some: { userId: subject, status: { not: 'REMOVED' } } } }] }] },
    select: { id: true, name: true, ownerId: true, members: { where: { status: { not: 'REMOVED' } }, select: { userId: true } },
      invites: { where: { acceptedAt: null, declinedAt: null, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true }, take: 1 },
      inviteLinks: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true }, take: 1 },
      teams: { orderBy: { id: 'asc' }, select: { id: true, name: true,
        members: { where: { status: { not: 'REMOVED' } }, select: { userId: true } } } } },
    orderBy: { id: 'asc' },
  }) : [];
  const contexts = orgs.filter(org => org.ownerId === subject || org.members.some(m => m.userId === subject)).map(org => {
    const shared = Boolean(org.ownerId && org.ownerId !== subject) || org.invites.length > 0 || org.inviteLinks.length > 0 ||
      org.members.some(m => m.userId !== subject) || org.teams.some(t => t.members.some(m => m.userId !== subject));
    return { orgId: org.id, name: org.name, shared, teams: org.teams.filter(t => t.members.some(m => m.userId === subject))
      .map(t => ({ teamId: t.id, name: t.name, shared: t.members.some(m => m.userId !== subject) })) };
  });
  const containers = await containerOptions(db, subject, policy);
  const impact = { containers, scope: 'PRODUCT_PERSON' as const, product: policy.id, name: policy.name, mode: policy.mode,
    revision: policy.revision, disclosure: policy.disclosure, contexts, domains: policy.domains, settings: policy.settings };
  return { impact, digest: createHash('sha256').update(JSON.stringify([subject,impact])).digest('hex') };
}

export async function commitProductErasure(db: Db, subject: string, policy: ProductErasurePolicy, digest: string, container?: Container) {
  const existing = await db.productErasureJob.findUnique({ where: { subject_policyId: { subject, policyId: policy.id } } });
  if (existing) {
    const original = existing.requestedContainer as Container | null;
    if (container && (container.id !== original?.id || container.scope !== original.scope)) {
      throw new AppError('BAD_REQUEST', 409, 'DELETION_RETRY_MISMATCH');
    }
    return { receipt: existing.id, complete: Boolean(existing.completedAt) };
  }
  await db.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id=${subject} FOR UPDATE`);
  const preview = await productImpact(db, subject, policy);
  if (digest !== preview.digest) throw new AppError('BAD_REQUEST', 409, 'DELETION_PREVIEW_CHANGED');
  const selected = container && preview.impact.containers.find(c => c.id === container.id && c.scope === container.scope);
  if (container && !selected) throw new AppError('BAD_REQUEST', 409, 'DELETION_PREVIEW_CHANGED');
  const requestedContainer = selected ? { scope: selected.scope, id: selected.id, name: selected.name, scopeDigest: selected.scopeDigest, teamIds: selected.teamIds } : undefined;
  const domains = await db.clientDomain.findMany({ where: { domain: { in: policy.domains }, status: 'active' }, select: { id: true } });
  if (domains.length !== policy.domains.length) throw new AppError('BAD_REQUEST', 409, 'DELETION_INVENTORY_UNAVAILABLE');
  const clients = await db.oAuthClient.findMany({ where: { nativeApp: { identifier: { in: policy.nativeApps } } }, select: { clientId: true } });
  const domain = { in: policy.domains };
  const clientIds = { in: clients.map(client => client.clientId) };
  await db.refreshToken.updateMany({ where: { userId: subject, revokedAt: null, OR: [{ domain }, { clientId: clientIds }] },
    data: { revokedAt: new Date() } });
  for (const clientDomain of policy.domains) {
    await revokeEnterpriseScope({ clientDomain, scope: 'user', userId: subject, revision: policy.revision }, db);
  }
  await db.loginLog.deleteMany({ where: { userId: subject, domain } });
  const retiredRoles = await db.domainRole.findMany({ where: { userId: subject, domain, role: 'SUPERUSER' }, select: { domain: true } });
  const newlyClosed = retiredRoles.map(r => r.domain).filter(d => !policy.closedBootstrapDomains.includes(d));
  if (newlyClosed.length) await db.productErasurePolicy.update({ where: { id: policy.id }, data: { closedBootstrapDomains: { push: newlyClosed } } });
  await db.domainRole.deleteMany({ where: { userId: subject, domain } });
  await db.authenticationEvidence.updateMany({ where: { userId: subject, clientDomain: domain, revokedAt: null }, data: { revokedAt: new Date() } });
  await db.debugLoginGrant.deleteMany({ where: { userId: subject, domain } });
  await db.machineEnrollment.updateMany({ where: { subject, clientDomain: domain, status: { not: 'revoked' } },
    data: { status: 'revoked', reason: 'all_devices_revoked', sourceVersion: { increment: 1 } } });
  await db.verificationToken.deleteMany({ where: { userId: subject, domain, type: { not: 'ACCOUNT_DELETION' } } });
  await db.authorizationCode.deleteMany({ where: { userId: subject, OR: [{ domain }, { oauthClientId: clientIds }] } });
  await db.billingServiceAccess.deleteMany({ where: { userId: subject,
    appKey: { actorIssuer: { in: policy.domains.map(d => 'https://' + d) } } } });
  for (const setting of policy.settings) {
    const [namespace, key] = setting.split('/');
    await db.userSetting.deleteMany({ where: { userId: subject, namespace, key } });
  }
  const job = await db.productErasureJob.create({ data: { subject, policyId: policy.id, revision: policy.revision,
    requestedContainer, impact: { ...preview.impact, containers: [], contexts: preview.impact.contexts.map(c => ({
      orgId: c.orgId, shared: c.shared, teams: c.teams.map(t => ({ teamId: t.teamId, shared: t.shared })),
    })) }, completedAt: domains.length ? null : new Date(),
    receipts: { create: domains.map(d => ({ domainId: d.id })) } } });
  return { receipt: job.id, complete: Boolean(job.completedAt) };
}

export async function acknowledgeProductErasure(input: { id: string; revision: number; outcome: 'PURGED' | 'RETAINED_EVIDENCE';
  domain: string; token: string }) {
  return getAdminPrisma().$transaction(async tx => {
    await lockProductTeamPolicyShared(tx);
    const auth = await verifyDomainAuthToken({ domain: input.domain, token: input.token }, { prisma: tx as PrismaClient });
    await tx.$queryRaw(Prisma.sql`SELECT id FROM entity_deletion_jobs WHERE id=(
      SELECT container_job_id FROM product_erasure_jobs WHERE id=${input.id}) FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM product_erasure_jobs WHERE id=${input.id} FOR UPDATE`);
    const where = { jobId_domainId: { jobId: input.id, domainId: auth.clientDomainId } };
    const row = await tx.productErasureReceipt.findUnique({ where, include: { job: true } });
    if (!row || row.job.revision !== input.revision) throw new AppError('NOT_FOUND', 404);
    if (row.acknowledgedAt && row.outcome !== input.outcome) throw new AppError('BAD_REQUEST', 409, 'DELETION_ACK_MISMATCH');
    if (!row.acknowledgedAt) {
      await tx.productErasureReceipt.update({ where, data: { outcome: input.outcome, acknowledgedAt: new Date() } });
      const container = row.job.containerJobId && await tx.entityDeletionJob.findUniqueOrThrow({ where: { id: row.job.containerJobId } });
      if ((!row.job.requestedContainer || (container && container.status === 'COMPLETE')) && !await tx.productErasureReceipt.count({ where: { jobId: input.id, acknowledgedAt: null } })) {
        await tx.productErasureJob.update({ where: { id: input.id }, data: { completedAt: new Date() } });
      }
    }
    return { ok: true };
  });
}
