import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import {
  revokeRefreshTokenFamiliesForUserOrganisation,
  revokeRefreshTokensForUserDomain,
} from './refresh-token.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockWorkspaceMembershipRows } from './workspace-scope.service.js';

import {
  assertDatabaseEnabled,
  auditOrg,
  getOrganisationMember,
  resolveOrganisationByDomain,
  type OrgServiceDeps,
  type OrgServicePrisma,
} from './organisation.service.base.js';

// Membership deactivation/reactivation (design §4.5). Split out of organisation.service.members.ts
// to keep that file under the 500-line project limit; both files share the `auditOrg` helper and
// tenant-resolution/actor-authorization helpers from organisation.service.base.ts.

async function requireOrgManagerActor(
  prisma: OrgServicePrisma,
  orgId: string,
  actorUserId: string,
): Promise<void> {
  const actorMembership = await getOrganisationMember(prisma, { orgId, userId: actorUserId }, { activeOnly: true });
  if (!actorMembership || (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')) {
    throw new AppError('FORBIDDEN', 403);
  }
}

export async function deactivateOrganisationMember(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    userId: string;
  },
  deps?: OrgServiceDeps & {
    revokeRefreshTokenFamiliesForUserOrganisation?:
      typeof revokeRefreshTokenFamiliesForUserOrganisation;
    revokeRefreshTokensForUserDomain?: typeof revokeRefreshTokensForUserDomain;
    afterMembershipStatusWrite?: () => Promise<void>;
  },
): Promise<{ deactivated: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();
  if (!actorUserId || !userId) throw new AppError('BAD_REQUEST', 400);

  // Membership status and cross-product refresh-family revocation must commit together. The
  // tenant role cannot see refresh rows issued by sibling product domains, so this lifecycle
  // boundary deliberately uses the BYPASSRLS client and repeats every authorization check.
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  await requireOrgManagerActor(prisma, org.id, actorUserId);

  // Target must currently be ACTIVE — a DEACTIVATED/REMOVED row has nothing further to
  // deactivate, and never deactivate an owner (must transfer ownership first).
  const member = await prisma.orgMember.findFirst({
    where: { orgId: org.id, userId, status: 'ACTIVE' },
    select: { id: true, role: true },
  });
  if (!member) throw new AppError('NOT_FOUND', 404);
  if (member.role === 'owner') throw new AppError('BAD_REQUEST', 400);

  await runInTransaction(prisma, async (tx) => {
    await lockRefreshSessionUserDomain({ userId, domain: org.domain }, { prisma: tx });
    await lockWorkspaceMembershipRows({ userId, orgId: org.id }, { prisma: tx });
    const lockedMember = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId, status: 'ACTIVE' },
      select: { id: true, role: true },
    });
    if (!lockedMember) throw new AppError('NOT_FOUND', 404);
    if (lockedMember.role === 'owner') throw new AppError('BAD_REQUEST', 400);

    const now = new Date();
    await tx.orgMember.update({
      where: { id: lockedMember.id },
      data: { status: 'DEACTIVATED', statusChangedAt: now },
    });
    await tx.teamMember.updateMany({
      where: { userId, team: { orgId: org.id }, status: 'ACTIVE' },
      data: { status: 'DEACTIVATED', statusChangedAt: now },
    });
    await deps?.afterMembershipStatusWrite?.();

    const revokeDeps = { now: () => now, prisma: tx };
    await (
      deps?.revokeRefreshTokenFamiliesForUserOrganisation ??
      revokeRefreshTokenFamiliesForUserOrganisation
    )(userId, org.id, revokeDeps);
    // Preserve the historical same-domain contract for legacy unscoped sessions while the exact
    // organisation revocation above catches scoped sessions issued by every product domain.
    await (deps?.revokeRefreshTokensForUserDomain ?? revokeRefreshTokensForUserDomain)(
      userId,
      org.domain,
      revokeDeps,
    );
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    action: 'member.deactivated',
    targetType: 'org_member',
    targetId: member.id,
    metadata: { userId },
  });

  return { deactivated: true };
}

export async function reactivateOrganisationMember(
  params: {
    orgId: string;
    domain: string;
    actorUserId: string;
    userId: string;
  },
  deps?: OrgServiceDeps & {
    afterMembershipStatusWrite?: () => Promise<void>;
  },
): Promise<{ reactivated: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = params.actorUserId.trim();
  const userId = params.userId.trim();
  if (!actorUserId || !userId) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisationByDomain(prisma, params);

  await requireOrgManagerActor(prisma, org.id, actorUserId);

  // Only a DEACTIVATED row may be reactivated here — a REMOVED member re-joins through
  // addOrganisationMember (the "re-add reactivates" path), not this endpoint.
  const member = await prisma.orgMember.findFirst({
    where: { orgId: org.id, userId, status: 'DEACTIVATED' },
    select: { id: true },
  });
  if (!member) throw new AppError('NOT_FOUND', 404);

  const now = new Date();
  await runInTransaction(prisma, async (tx) => {
    await lockWorkspaceMembershipRows({ userId, orgId: org.id }, { prisma: tx });
    const lockedMember = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId, status: 'DEACTIVATED' },
      select: { id: true },
    });
    if (!lockedMember) throw new AppError('NOT_FOUND', 404);

    await tx.orgMember.update({
      where: { id: lockedMember.id },
      data: { status: 'ACTIVE', statusChangedAt: now },
    });
    await tx.teamMember.updateMany({
      where: { userId, team: { orgId: org.id }, status: 'DEACTIVATED' },
      data: { status: 'ACTIVE', statusChangedAt: now },
    });
    await deps?.afterMembershipStatusWrite?.();
  });

  // No session restore (design §4.5) — the user simply signs in again.
  await auditOrg({
    orgId: org.id,
    actorUserId,
    action: 'member.reactivated',
    targetType: 'org_member',
    targetId: member.id,
    metadata: { userId },
  });

  return { reactivated: true };
}
