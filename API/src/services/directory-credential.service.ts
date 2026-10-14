import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { runInTransaction } from '../db/tenant-context.js';
import { lockProductTeamPolicyExclusive, lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { requireLifecycleActor, type LifecycleActor } from './internal-admin-lifecycle.service.js';

const MAX_LIFETIME_MS = 90 * 24 * 60 * 60_000;
const MAX_OVERLAP_MS = 10 * 60_000;
const digest = (secret: string) => createHash('sha256').update(`uoa:directory:v1:${secret}`).digest('hex');
const unauthorized = () => new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
function secret() { const value = 'uoa_dir_' + randomBytes(32).toString('base64url'); return { value, digest: digest(value), prefix: value.slice(0, 16) }; }

/** Operator-only issuance is distinct from owner permission to read an org. */
export async function issueDirectoryCredential(input: { clientDomainId: string; label: string; expiresAt: Date; actor: LifecycleActor }, prisma: PrismaClient) {
  if (!input.label.trim() || input.label.trim().length > 120 || !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt <= new Date() || input.expiresAt.getTime() > Date.now() + MAX_LIFETIME_MS) throw new AppError('BAD_REQUEST', 400);
  return runInTransaction(prisma, async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx, input.actor);
    const domain = await tx.clientDomain.findUnique({ where: { id: input.clientDomainId }, select: { id: true, status: true, domain: true } });
    if (domain?.status !== 'active') throw new AppError('NOT_FOUND', 404);
    // A queued operator request must not issue an already-expired credential.
    if (input.expiresAt <= new Date()) throw new AppError('BAD_REQUEST', 400);
    const token = secret();
    const row = await tx.directoryCredential.create({ data: { id: randomUUID(), clientDomainId: domain.id,
      label: input.label.trim(), expiresAt: input.expiresAt,
      secrets: { create: { id: randomUUID(), digest: token.digest, prefix: token.prefix, expiresAt: input.expiresAt } } } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'directory.credential_issued', targetDomain: domain.domain,
      metadata: { credentialId: row.id, expiresAt: input.expiresAt.toISOString() } } });
    return { id: row.id, secret: token.value, expires_at: row.expiresAt.toISOString() };
  });
}

export async function rotateDirectoryCredential(input: { credentialId: string; overlapSeconds: number; actor: LifecycleActor }, prisma: PrismaClient) {
  if (!Number.isSafeInteger(input.overlapSeconds) || input.overlapSeconds < 0 || input.overlapSeconds * 1000 > MAX_OVERLAP_MS) throw new AppError('BAD_REQUEST', 400);
  return runInTransaction(prisma, async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx, input.actor);
    const row = await tx.directoryCredential.findUnique({ where: { id: input.credentialId } });
    if (!row || row.revokedAt || row.expiresAt <= new Date()) throw new AppError('NOT_FOUND', 404);
    const domain = await tx.clientDomain.findUnique({ where: { id: row.clientDomainId }, select: { status: true } });
    if (domain?.status !== 'active') throw new AppError('NOT_FOUND', 404);
    const overlap = new Date(Math.min(row.expiresAt.getTime(), Date.now() + input.overlapSeconds * 1000));
    await tx.directoryCredentialSecret.updateMany({ where: { credentialId: row.id, expiresAt: { gt: overlap } }, data: { expiresAt: overlap } });
    const token = secret();
    await tx.directoryCredentialSecret.create({ data: { id: randomUUID(), credentialId: row.id,
      digest: token.digest, prefix: token.prefix, expiresAt: row.expiresAt } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'directory.credential_rotated', metadata: { credentialId: row.id, overlapSeconds: input.overlapSeconds } } });
    return { id: row.id, secret: token.value, expires_at: row.expiresAt.toISOString(), previous_secrets_expire_at: overlap.toISOString() };
  });
}

export async function revokeDirectoryCredential(input: { credentialId: string; actor: LifecycleActor }, prisma: PrismaClient) {
  return runInTransaction(prisma, async tx => {
    await lockProductTeamPolicyExclusive(tx);
    const actorEmail = await requireLifecycleActor(tx, input.actor);
    await tx.directoryCredential.updateMany({ where: { id: input.credentialId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.adminAuditLog.create({ data: { actorEmail, action: 'directory.credential_revoked', metadata: { credentialId: input.credentialId } } });
    return { ok: true };
  });
}

/** Shared policy lock is held through each read; revoke/grant writers take its
 * exclusive form. No positive credential/grant authority is cached. */
export async function authorizeDirectoryRead(input: { authorization?: string; orgId: string; permission: 'MEMBERSHIP_READ' | 'DISPLAY_READ' | 'WEBHOOK_MANAGE' }, tx: PrismaClient) {
  await lockProductTeamPolicyShared(tx);
  const raw = input.authorization;
  if (typeof raw !== 'string' || !/^Bearer uoa_dir_[A-Za-z0-9_-]{43}$/.test(raw)) throw unauthorized();
  const row = await tx.directoryCredentialSecret.findUnique({ where: { digest: digest(raw.slice(7)) }, include: { credential: true } });
  const now = new Date();
  if (!row || row.expiresAt <= now || row.credential.expiresAt <= now || row.credential.revokedAt) throw unauthorized();
  const domain = await tx.clientDomain.findUnique({ where: { id: row.credential.clientDomainId }, select: { status: true } });
  if (domain?.status !== 'active') throw unauthorized();
  const grant = await tx.directoryOrganisationGrant.findUnique({ where: { credentialId_orgId: { credentialId: row.credentialId, orgId: input.orgId } } });
  if (!grant || grant.revokedAt || !grant.permissions.includes(input.permission)) throw new AppError('FORBIDDEN', 403);
  return { credentialId: row.credentialId, clientDomainId: row.credential.clientDomainId, grantId: grant.id };
}

export async function listDirectoryCredentials(actor: LifecycleActor, prisma: PrismaClient) {
  return runInTransaction(prisma, async tx => {
    await requireLifecycleActor(tx, actor);
    const rows = await tx.directoryCredential.findMany({ orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, clientDomainId: true, label: true, expiresAt: true, revokedAt: true,
        createdAt: true, secrets: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2, select: { id: true, prefix: true, expiresAt: true } } } });
    return { data: rows };
  });
}
