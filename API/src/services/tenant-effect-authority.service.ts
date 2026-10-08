import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

import { getAdminAuthDomain } from '../config/env.js';
import type { TenantContext } from '../db/tenant-context.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import { verifyDomainAuthToken } from './domain-secret.service.js';
import { assertEntityAccess } from './entity-lifecycle.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import {
  lockRefreshSessionUser,
  lockRefreshSessionUserShared,
} from './refresh-session-lock.service.js';

type EffectRequest = Pick<FastifyRequest, 'accessTokenClaims' | 'adminAccessTokenClaims' |
  'orgBackendCaller' | 'domainAuthClientDomainId' | 'domainAuthClientId' | 'params' | 'body'>;

function field(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === 'string' && result.trim().length > 0 && result.length <= 256
    ? result.trim() : undefined;
}

/** Hold live request authority through the tenant transaction's effects and commit.
 * Policy precedes sorted canonical user locks, matching lifecycle issuance/revocation.
 * Target identity comes from the route's known fields, never the RLS subject override.
 */
export async function assertTenantEffectAuthority(
  request: EffectRequest,
  context: TenantContext,
  tx: Prisma.TransactionClient,
  adminDb: PrismaClient,
  options?: { authority?: 'domain'; userEpochLock?: 'exclusive' | 'shared' },
): Promise<void> {
  await lockProductTeamPolicyShared(tx);
  const claims = request.adminAccessTokenClaims ?? request.accessTokenClaims;
  const backend = request.orgBackendCaller;
  if (!claims && options?.authority !== 'domain' && (!backend || !context.domainBackend ||
    normalizeDomain(backend.domain) !== normalizeDomain(context.domain))) deny();

  const userIds = [claims?.userId, field(request.params, 'userId'),
    field(request.body, 'userId'), field(request.body, 'newOwnerId'), field(request.body, 'ownerId')];
  for (const id of [...new Set(userIds.filter((id): id is string => Boolean(id)))].sort()) {
    if (options?.userEpochLock === 'shared') {
      await lockRefreshSessionUserShared(id, { prisma: tx });
    } else {
      await lockRefreshSessionUser(id, { prisma: tx });
    }
  }
  if (claims) {
    const user = await adminDb.user.findUnique({ where: { id: claims.userId },
      select: { lifecycleStatus: true, tokenVersion: true } });
    if (!user || user.lifecycleStatus !== 'ACTIVE' || user.tokenVersion !== claims.tokenVersion) deny();
    if (request.adminAccessTokenClaims) {
      const domain = normalizeDomain(getAdminAuthDomain());
      if (claims.role !== 'superuser' || normalizeDomain(claims.domain) !== domain) deny();
      const role = await adminDb.domainRole.findUnique({
        where: { domain_userId: { domain, userId: claims.userId } }, select: { role: true },
      });
      if (role?.role !== 'SUPERUSER') deny();
    } else {
      if (normalizeDomain(claims.domain) !== normalizeDomain(context.domain)) deny();
      const selectedOrg = claims.active?.orgId ?? claims.org?.org_id;
      await assertEntityAccess({ orgId: selectedOrg, teamId: claims.active?.teamId }, adminDb);
      if (selectedOrg) {
        const member = await adminDb.orgMember.findUnique({
          where: { orgId_userId: { orgId: selectedOrg, userId: claims.userId } },
          select: { status: true },
        });
        if (member?.status !== 'ACTIVE') deny();
      }
      if (claims.active?.teamId) {
        const member = await adminDb.teamMember.findUnique({
          where: { teamId_userId: { teamId: claims.active.teamId, userId: claims.userId } },
          select: { status: true },
        });
        if (member?.status !== 'ACTIVE') deny();
      }
    }
  }
  if (!request.adminAccessTokenClaims) {
    if (!request.domainAuthClientDomainId || !request.domainAuthClientId) deny();
    const authority = await verifyDomainAuthToken({ domain: context.domain,
      token: request.domainAuthClientId }, { prisma: adminDb });
    if (authority.clientDomainId !== request.domainAuthClientDomainId) deny();
  }
  if (options?.authority === 'domain' && context.orgId) {
    const org = await adminDb.organisation.findUnique({ where: { id: context.orgId }, select: { domain: true } });
    if (!org || normalizeDomain(org.domain) !== normalizeDomain(context.domain)) {
      throw new AppError('NOT_FOUND', 404);
    }
  }
  await assertEntityAccess({ orgId: context.orgId, teamId: field(request.params, 'teamId') }, adminDb);
}

function deny(): never { throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED'); }
