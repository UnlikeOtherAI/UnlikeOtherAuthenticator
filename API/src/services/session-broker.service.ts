import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { verifyChainedSubjectAccessToken } from './confidential-chained-token-exchange.service.js';
import { resolveConfidentialDelegationForSource } from './confidential-delegation.service.js';
import { isAuthenticationEpochMismatchError, lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { lockTokenIssuanceProductPolicy } from './product-team-policy-lock.service.js';
import { getActiveClientOrgContext } from './org-context.service.js';

export const SESSION_BROKER_SOURCE = 'coder.unlikeotherai.com';
export const SESSION_BROKER_RESOURCE = 'https://api.selkie.live';
export const SESSION_BROKER_SCOPE = 'session:broker';

export async function validateSessionBroker(params: { token: string; targetDomain: string },
  deps: { prisma?: PrismaClient; now?: () => number } = {}) {
  const forbidden = () => new AppError('FORBIDDEN', 403, 'SESSION_BROKER_FORBIDDEN');
  if (params.targetDomain !== 'api.selkie.live') throw forbidden();
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const subject = await verifyChainedSubjectAccessToken({ subjectToken: params.token,
    callerAudience: SESSION_BROKER_RESOURCE, issuer: getPublicBaseUrl() }, { now: () => now });
  if (subject.source_domain !== SESSION_BROKER_SOURCE || subject.azp !== SESSION_BROKER_SOURCE ||
    subject.product !== 'coder' || subject.scope !== SESSION_BROKER_SCOPE || subject.act) throw forbidden();
  const prisma = deps.prisma ?? getAdminPrisma();
  return runInTransaction(prisma, async (tx) => {
    const source = await tx.clientDomain.findUnique({ where: { domain: SESSION_BROKER_SOURCE }, select: { id: true } });
    const target = await tx.clientDomain.findUnique({ where: { domain: params.targetDomain }, select: { id: true, status: true } });
    if (!source || !target || target.status !== 'active') throw forbidden();
    for (const item of [{ id: source.id, domain: SESSION_BROKER_SOURCE }, { id: target.id, domain: params.targetDomain }]
      .sort((a, b) => a.id.localeCompare(b.id))) {
      await lockTokenIssuanceProductPolicy({ clientDomainId: item.id, domain: item.domain }, { prisma: tx });
    }
    await resolveConfidentialDelegationForSource({ sourceDomain: SESSION_BROKER_SOURCE,
      product: 'coder', resource: SESSION_BROKER_RESOURCE, scope: SESSION_BROKER_SCOPE }, { prisma: tx });
    try {
      await lockAndAssertAuthenticationEpoch({ userId: subject.sub, domain: SESSION_BROKER_SOURCE,
        credentialEpoch: subject.tv }, { prisma: tx });
    } catch (error) {
      if (isAuthenticationEpochMismatchError(error)) throw forbidden();
      throw error;
    }
    const [user, role, targetRole, org, targetOrg] = await Promise.all([
      tx.user.findUnique({ where: { id: subject.sub }, select: { id: true } }),
      tx.domainRole.findUnique({ where: { domain_userId: { domain: SESSION_BROKER_SOURCE, userId: subject.sub } },
        select: { role: true } }),
      tx.domainRole.findUnique({ where: { domain_userId: { domain: params.targetDomain, userId: subject.sub } },
        select: { role: true } }),
      getActiveClientOrgContext({ userId: subject.sub, domain: SESSION_BROKER_SOURCE,
        orgId: subject.active.orgId, groupsEnabled: false }, { prisma: tx, crossProductPrisma: tx, policyPrisma: tx }),
      getActiveClientOrgContext({ userId: subject.sub, domain: params.targetDomain,
        orgId: subject.active.orgId, groupsEnabled: false }, { prisma: tx, crossProductPrisma: tx, policyPrisma: tx }),
    ]);
    if (!user || !role || !targetRole || !org || !targetOrg || !targetOrg.teams.includes(subject.active.teamId) ||
      !org.teams.includes(subject.active.teamId) || subject.exp <= now) throw forbidden();
    return { sub: subject.sub, expires_at: new Date(subject.exp * 1000).toISOString(),
      active: { orgId: subject.active.orgId, teamId: subject.active.teamId } };
  });
}
