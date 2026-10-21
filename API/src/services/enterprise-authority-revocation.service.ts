import type { PrismaClient } from '@prisma/client';
import { revokeEnterpriseScope } from './org-sso-revocation.service.js';

/** Called inside an authority transaction, after its outbox fence and before deleting scope rows. */
export async function revokeEnterpriseUser(tx: PrismaClient, userId: string): Promise<void> {
  const [roles, memberships, assurances, refreshes] = await Promise.all([
    tx.domainRole.findMany({ where: { userId }, select: { domain: true } }),
    tx.orgMember.findMany({ where: { userId }, select: { org: { select: { domain: true } } } }),
    tx.sessionAssurance.findMany({ where: { userId }, select: { clientDomain: true } }),
    tx.refreshToken.findMany({ where: { userId }, distinct: ['domain'], select: { domain: true } }),
  ]);
  const domains = new Set([...roles.map(row => row.domain), ...memberships.map(row => row.org.domain),
    ...assurances.map(row => row.clientDomain), ...refreshes.map(row => row.domain)]);
  for (const clientDomain of [...domains].sort()) {
    await revokeEnterpriseScope({ clientDomain, scope: 'user', userId, revision: 1 }, tx);
  }
}

export async function revokeEnterpriseOrganisation(
  tx: PrismaClient, orgId: string, userId?: string,
): Promise<void> {
  const org = await tx.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { domain: true } });
  const domains = await scopedConsumerDomains(tx, { orgId, userId }, org.domain);
  for (const clientDomain of domains) {
    await revokeEnterpriseScope({ clientDomain, scope: 'organisation', orgId, userId, revision: 1 }, tx);
  }
}

export async function revokeEnterpriseTeam(tx: PrismaClient, teamId: string, userId?: string): Promise<void> {
  const team = await tx.team.findUniqueOrThrow({ where: { id: teamId },
    select: { orgId: true, org: { select: { domain: true } } } });
  const domains = await scopedConsumerDomains(tx, { orgId: team.orgId, teamId, userId }, team.org.domain);
  for (const clientDomain of domains) {
    await revokeEnterpriseScope({ clientDomain, scope: 'team', orgId: team.orgId,
      teamId, userId, revision: 1 }, tx);
  }
}

/** Server product policy can permit an exact org across origins. Notify every actual consumer
 * of that scope without treating an origin-domain credential as an organisation reference. */
async function scopedConsumerDomains(tx: PrismaClient,
  scope: { orgId: string; teamId?: string; userId?: string }, origin: string): Promise<string[]> {
  const [assurances, refreshes] = await Promise.all([
    tx.sessionAssurance.findMany({ where: scope, distinct: ['clientDomain'], select: { clientDomain: true } }),
    tx.refreshToken.findMany({ where: scope, distinct: ['domain'], select: { domain: true } }),
  ]);
  return [...new Set([origin, ...assurances.map(row => row.clientDomain), ...refreshes.map(row => row.domain)])].sort();
}
