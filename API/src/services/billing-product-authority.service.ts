import { type Prisma, type BillingProductEnrollment } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';

export function commercialSourceDomain(issuer: string): string {
  const url = new URL(issuer);
  return `${url.host}${url.pathname.replace(/\/$/, '')}`;
}

/** Recheck revocation, source registration and exact company enrollment online. */
export async function lockCommercialAuthority(tx: Prisma.TransactionClient,
  input: { credential: VerifiedBillingAppKey; product: string; organisationId: string;
    purpose: 'ENTITLEMENT' | 'COMMERCIAL_WORKER' | 'CUSTOMER_LIFECYCLE' },
): Promise<BillingProductEnrollment> {
  const { credential } = input;
  if (credential.purpose !== input.purpose || credential.service.identifier !== input.product) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  }
  await tx.$queryRaw`SELECT id FROM billing_app_keys WHERE id=${credential.id} FOR SHARE`;
  const key = await tx.billingAppKey.findFirst({ where: {
    id: credential.id, serviceId: credential.service.id, purpose: input.purpose,
    actorIssuer: credential.actorIssuer, revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], service: { active: true },
  } });
  const domain = commercialSourceDomain(credential.actorIssuer);
  await tx.$queryRaw`SELECT id FROM client_domains WHERE domain=${domain} FOR SHARE`;
  const source = await tx.clientDomain.findFirst({ where: { domain, status: 'active' } });
  const company = await tx.organisation.findFirst({ where: {
    id: input.organisationId, lifecycleStatus: 'ACTIVE',
  } });
  const enrollment = await tx.billingProductEnrollment.findFirst({ where: {
    serviceId: credential.service.id, orgId: input.organisationId, sourceDomain: domain, active: true,
  } });
  if (!key || !source || !company || !enrollment) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_COMMERCIAL_SCOPE_NOT_ENTITLED');
  }
  return enrollment;
}

export async function commercialMember(tx: Prisma.TransactionClient, input: {
  organisationId: string; teamId: string; userId: string; tokenVersion?: number;
}): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM users WHERE id=${input.userId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM org_members WHERE org_id=${input.organisationId} AND user_id=${input.userId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM teams WHERE id=${input.teamId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM team_members WHERE team_id=${input.teamId} AND user_id=${input.userId} FOR SHARE`;
  const user = await tx.user.findFirst({ where: { id: input.userId, lifecycleStatus: 'ACTIVE',
    ...(input.tokenVersion === undefined ? {} : { tokenVersion: input.tokenVersion }) } });
  const member = await tx.orgMember.findFirst({ where: {
    orgId: input.organisationId, userId: input.userId, status: 'ACTIVE',
  } });
  const team = await tx.team.findFirst({ where: {
    id: input.teamId, orgId: input.organisationId, lifecycleStatus: 'ACTIVE',
    members: { some: { userId: input.userId, status: 'ACTIVE' } },
  } });
  if (!user || !member || !team) throw new AppError('FORBIDDEN', 403, 'BILLING_SUBJECT_NOT_ENTITLED');
  return member.role === 'owner' || member.role === 'admin';
}
