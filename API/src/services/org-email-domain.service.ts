import { resolveTxt } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { randomBytes } from 'node:crypto';
import { getDomain, getPublicSuffix } from 'tldts';
import type { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { lockEnterpriseScope, type managementSession } from './org-sso-management.service.js';
import { revokeEnterpriseScope } from './org-sso-revocation.service.js';

const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com']);
export function normalizeEnterpriseEmailDomain(raw: string): string {
  const domain = domainToASCII(raw.trim().toLowerCase().replace(/\.$/, ''));
  if (!domain || domain.length > 253 || domain.includes('@') || domain.includes('*') ||
    !getDomain(domain, { allowPrivateDomains: true }) || getPublicSuffix(domain) === domain || PUBLIC_MAIL.has(domain)) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_EMAIL_DOMAIN_INVALID');
  }
  return domain;
}
type Session = Awaited<ReturnType<typeof managementSession>>;
export async function createEnterpriseDomain(session: Session, raw: string, tx: Prisma.TransactionClient) {
  const emailDomain = normalizeEnterpriseEmailDomain(raw);
  await lockEnterpriseScope(tx, session.clientDomain, `email-domain:${emailDomain}`);
  const org = await tx.organisation.findUniqueOrThrow({ where: { id: session.orgId }, select: { domain: true } });
  // Cross-origin claim authorization is not yet approved. Existing cross-origin memberships remain supported.
  if (org.domain !== session.clientDomain) throw new AppError('FORBIDDEN', 403, 'SSO_ORIGIN_DOMAIN_REQUIRED');
  const now = new Date();
  await tx.organisationEmailDomain.updateMany({ where: { clientDomain: session.clientDomain, emailDomain,
    status: 'PENDING', challengeExpiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
  if (await tx.organisationEmailDomain.findFirst({ where: { clientDomain: session.clientDomain, emailDomain,
    status: { in: ['PENDING', 'VERIFIED'] } }, select: { id: true } })) {
    throw new AppError('BAD_REQUEST', 409, 'SSO_EMAIL_DOMAIN_CLAIMED');
  }
  const challenge = `uoa-verification=${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + 86400000);
  const row = await tx.organisationEmailDomain.create({ data: { clientDomain: session.clientDomain,
    orgId: session.orgId, emailDomain, challengeHash: hashAssuranceReference(challenge), challengeExpiresAt: expiresAt } });
  return { ok: true, domain: { id: row.id, email_domain: emailDomain, status: row.status,
    challenge: { name: `_uoa-verification.${emailDomain}`, value: challenge, expires_at: expiresAt.toISOString() } } };
}

export async function verifyEnterpriseDomain(session: Session, id: string, tx: Prisma.TransactionClient,
  resolver = resolveTxt) {
  const row = await tx.organisationEmailDomain.findFirst({ where: { id, clientDomain: session.clientDomain, orgId: session.orgId } });
  if (!row || row.status !== 'PENDING' || row.challengeExpiresAt <= new Date()) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_EMAIL_DOMAIN_PROOF_EXPIRED');
  }
  let records: string[][];
  try { records = await resolver(`_uoa-verification.${row.emailDomain}`); }
  catch { throw new AppError('BAD_REQUEST', 400, 'SSO_EMAIL_DOMAIN_PROOF_NOT_FOUND'); }
  if (!records.slice(0, 100).some((record) => hashAssuranceReference(record.join('')) === row.challengeHash)) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_EMAIL_DOMAIN_PROOF_NOT_FOUND');
  }
  const now = new Date();
  await tx.organisationEmailDomain.update({ where: { id }, data: { status: 'VERIFIED', verifiedAt: now, checkedAt: now, failures: 0 } });
  return { ok: true, domain: { id, email_domain: row.emailDomain, status: 'VERIFIED' } };
}

export async function reissueEnterpriseDomain(session: Session, id: string, tx: Prisma.TransactionClient) {
  const row = await tx.organisationEmailDomain.findFirst({ where: { id,
    clientDomain: session.clientDomain, orgId: session.orgId } });
  if (!row || !['PENDING', 'EXPIRED'].includes(row.status)) throw new AppError('BAD_REQUEST', 409, 'SSO_EMAIL_DOMAIN_REISSUE_REFUSED');
  await lockEnterpriseScope(tx, session.clientDomain, `email-domain:${row.emailDomain}`);
  if (await tx.organisationEmailDomain.findFirst({ where: { id: { not: id }, clientDomain: session.clientDomain,
    emailDomain: row.emailDomain, status: { in: ['PENDING', 'VERIFIED'] } } })) {
    throw new AppError('BAD_REQUEST', 409, 'SSO_EMAIL_DOMAIN_CLAIMED');
  }
  const value = `uoa-verification=${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + 86400000);
  await tx.organisationEmailDomain.update({ where: { id }, data: { status: 'PENDING',
    challengeHash: hashAssuranceReference(value), challengeExpiresAt: expiresAt, failures: 0 } });
  await tx.orgAuditLog.create({ data: { orgId: row.orgId, actorUserId: session.userId,
    action: 'sso.domain_proof_reissued', targetType: 'organisation', targetId: id, metadata: {} } });
  return { ok: true, domain: { id, email_domain: row.emailDomain, status: 'PENDING',
    challenge: { name: `_uoa-verification.${row.emailDomain}`, value, expires_at: expiresAt.toISOString() } } };
}

export async function revokeEnterpriseDomain(session: Session, id: string, tx: Prisma.TransactionClient) {
  const row = await tx.organisationEmailDomain.findFirst({ where: { id, clientDomain: session.clientDomain, orgId: session.orgId } });
  if (!row) throw new AppError('NOT_FOUND', 404);
  await tx.organisationEmailDomain.update({ where: { id }, data: { status: 'REVOKED' } });
  const links = await tx.externalIdentity.findMany({ where: { domainClaimId: id }, select: { id: true, userId: true, connectionId: true } });
  await tx.externalIdentity.updateMany({ where: { domainClaimId: id }, data: { status: 'SUSPENDED' } });
  for (const link of links) {
    await tx.orgSsoGrant.updateMany({ where: { connectionId: link.connectionId, userId: link.userId }, data: { revokedAt: new Date() } });
    await revokeEnterpriseScope({ scope: 'connection', clientDomain: session.clientDomain,
      orgId: session.orgId, userId: link.userId, connectionId: link.connectionId, revision: 1 }, tx);
  }
  return { ok: true };
}
