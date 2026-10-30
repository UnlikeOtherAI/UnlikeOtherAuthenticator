import { getAdminAuthDomain, getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { normalizeDomain } from '../utils/domain.js';
import { sendRawEmail } from './email.service.js';
import { writeAuditLog, type AuditLogPrisma } from './audit-log.service.js';

const HOUR = 60 * 60 * 1000;

/** Only call after consuming a mailbox/2FA proof for this exact subject. */
export async function requestAccountRenewal(userId: string): Promise<{ ok: true }> {
  const prisma = getAdminPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId },
    select: { id: true, email: true, lifecycleStatus: true, accountExpiresAt: true } });
  if (!user || user.lifecycleStatus !== 'ACTIVE' || !user.accountExpiresAt || user.accountExpiresAt > new Date()) return { ok: true };

  const request = await runInTransaction(prisma, async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
    const current = await tx.user.findUnique({ where: { id: user.id }, select: { lifecycleStatus: true, accountExpiresAt: true } });
    if (current?.lifecycleStatus !== 'ACTIVE' || !current.accountExpiresAt || current.accountExpiresAt > new Date()) return null;
    const prior = await tx.accountRenewalRequest.findUnique({ where: { userId: user.id } });
    const now = new Date();
    if (prior?.status === 'PENDING' && prior.notifiedAt && now.getTime() - prior.notifiedAt.getTime() < HOUR) return null;
    if (prior?.status === 'DECLINED' && now.getTime() - prior.requestedAt.getTime() < HOUR) return null;
    return tx.accountRenewalRequest.upsert({ where: { userId: user.id },
      create: { userId: user.id, status: 'PENDING', requestedAt: now },
      update: { status: 'PENDING', requestedAt: now, notifiedAt: null, reviewedAt: null, reviewedByUserId: null, approvedUntil: null },
      select: { id: true } });
  });
  if (!request) return { ok: true };

  const roles = await prisma.domainRole.findMany({ where: { domain: normalizeDomain(getAdminAuthDomain()), role: 'SUPERUSER',
    user: { lifecycleStatus: 'ACTIVE' } }, include: { user: { select: { email: true, accountExpiresAt: true } } } });
  const recipients = [...new Set(roles.filter(row => !row.user.accountExpiresAt || row.user.accountExpiresAt > new Date())
    .map(row => row.user.email?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))];
  if (!recipients.length) return { ok: true }; // Pending stays visible in Admin even without email delivery.
  const env = getEnv();
  const from = env.EMAIL_FROM;
  if (!from) return { ok: true }; // No sender is configured; a retry remains eligible.
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') ?? `http://${env.HOST}:${env.PORT}`;
  const reviewUrl = `${base}/admin/users/${encodeURIComponent(user.id)}?tab=security`;
  const content = `An expired UOA account has requested renewed access: ${user.email}.\n\nReview the request: ${reviewUrl}\n\nSign in as a platform administrator to approve with a new expiry date or decline.`;
  // A delivery failure leaves notifiedAt empty, so a later request can retry delivery.
  const outcomes = await Promise.allSettled(recipients.map(to => sendRawEmail({ to, from,
    subject: 'UOA account renewal request', text: content })));
  if (outcomes.some(outcome => outcome.status === 'fulfilled')) {
    await prisma.accountRenewalRequest.updateMany({ where: { id: request.id, status: 'PENDING' }, data: { notifiedAt: new Date() } });
  }
  return { ok: true };
}

export async function reviewAccountRenewal(params: {
  requestId: string; actorUserId: string; actorEmail: string; decision: 'approve' | 'decline'; accountExpiresAt?: string;
}) {
  const expiry = params.accountExpiresAt ? new Date(params.accountExpiresAt) : null;
  if (params.decision === 'approve' && (!expiry || !Number.isFinite(expiry.getTime()) || expiry <= new Date()) ||
      params.decision === 'decline' && params.accountExpiresAt) throw new AppError('BAD_REQUEST', 400, 'INVALID_ACCOUNT_EXPIRY');
  const prisma = getAdminPrisma();
  const userId = await runInTransaction(prisma, async tx => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM account_renewal_requests WHERE id = ${params.requestId} FOR UPDATE`;
    if (!locked.length) throw new AppError('NOT_FOUND', 404);
    const request = await tx.accountRenewalRequest.findUnique({ where: { id: params.requestId },
      include: { user: { select: { id: true, email: true, lifecycleStatus: true, accountExpiresAt: true } } } });
    if (!request || request.status !== 'PENDING' || request.user.lifecycleStatus !== 'ACTIVE' ||
        !request.user.accountExpiresAt || request.user.accountExpiresAt > new Date()) {
      throw new AppError('BAD_REQUEST', 409, 'ACCOUNT_RENEWAL_NOT_PENDING');
    }
    if (expiry) await tx.user.update({ where: { id: request.userId }, data: { accountExpiresAt: expiry } });
    await tx.accountRenewalRequest.update({ where: { id: request.id }, data: {
      status: expiry ? 'APPROVED' : 'DECLINED', reviewedAt: new Date(), reviewedByUserId: params.actorUserId,
      approvedUntil: expiry,
    } });
    await writeAuditLog({ actorEmail: params.actorEmail, action: expiry ? 'user.account_renewal_approved' : 'user.account_renewal_declined',
      metadata: { userId: request.userId, requestId: request.id, accountExpiresAt: expiry?.toISOString() ?? null } },
    { prisma: tx as unknown as AuditLogPrisma });
    return request.userId;
  });
  return { userId, status: expiry ? 'approved' : 'declined', accountExpiresAt: expiry?.toISOString() ?? null };
}

export async function setAdminUserExpiry(params: { userId: string; actorEmail: string; accountExpiresAt: string | null }) {
  const expiry = params.accountExpiresAt ? new Date(params.accountExpiresAt) : null;
  if (expiry && (!Number.isFinite(expiry.getTime()) || expiry <= new Date())) throw new AppError('BAD_REQUEST', 400, 'INVALID_ACCOUNT_EXPIRY');
  const prisma = getAdminPrisma();
  await runInTransaction(prisma, async tx => {
    const user = await tx.user.findUnique({ where: { id: params.userId }, select: { id: true, lifecycleStatus: true } });
    if (!user || user.lifecycleStatus !== 'ACTIVE') throw new AppError('NOT_FOUND', 404);
    await tx.user.update({ where: { id: user.id }, data: { accountExpiresAt: expiry } });
    await tx.accountRenewalRequest.updateMany({ where: { userId: user.id, status: 'PENDING' }, data: {
      status: 'APPROVED', reviewedAt: new Date(), approvedUntil: expiry,
    } });
    await writeAuditLog({ actorEmail: params.actorEmail, action: 'user.account_expiry_updated',
      metadata: { userId: user.id, accountExpiresAt: expiry?.toISOString() ?? null } },
    { prisma: tx as unknown as AuditLogPrisma });
  });
  return { accountExpiresAt: expiry?.toISOString() ?? null };
}
