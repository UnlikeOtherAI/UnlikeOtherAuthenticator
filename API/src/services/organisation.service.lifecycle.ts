import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import {
  revokeRefreshTokenFamiliesForUserOrganisation,
  revokeRefreshTokensForUserDomain,
} from './refresh-token-revocation.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockWorkspaceMembershipRows } from './workspace-scope.service.js';

import {
  assertDatabaseEnabled,
  auditOrg,
  getOrganisationMember,
  requireOrgCapability,
  resolveOrgActor,
  resolveOrganisation,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
} from './organisation.service.base.js';

// Membership deactivation/reactivation (design §4.5). Split out of organisation.service.members.ts
// to keep that file under the 500-line project limit; both files share the `auditOrg` helper and
// tenant-resolution/actor-authorization helpers from organisation.service.base.ts.

/**
 * Require that the ACTING USER holds `members.manage` at org scope.
 *
 * Deactivating and reactivating an org membership is roster mutation — the same family as adding
 * and removing one — so it resolves the same capability rather than a second name, and a domain
 * that grants a custom role the roster gets the whole roster rather than three of its four verbs.
 *
 * `actorUserId: undefined` means there is no acting user because the domain pairing authorised the
 * call (backend mode): there is no membership to check, and the caller already holds authority over
 * the whole tenant. `resolveOrgActor` is what proves the distinction; this helper never invents it.
 */
async function requireOrgMemberManager(
  prisma: OrgServicePrisma,
  params: { orgId: string; actorUserId: string | undefined; config: ClientConfig },
): Promise<void> {
  if (!params.actorUserId) return;
  const actorMembership = await getOrganisationMember(
    prisma,
    { orgId: params.orgId, userId: params.actorUserId },
    { activeOnly: true },
  );
  requireOrgCapability(params.config, 'members.manage', actorMembership?.role);
}

export async function deactivateOrganisationMember(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    config: ClientConfig;
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

  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);

  // Membership status and cross-product refresh-family revocation must commit together. The
  // tenant role cannot see refresh rows issued by sibling product domains, so this lifecycle
  // boundary deliberately uses the BYPASSRLS client and repeats every authorization check.
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });

  await requireOrgMemberManager(prisma, { orgId: org.id, actorUserId, config: params.config });

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
    actor: params.actor,
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
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps & {
    afterMembershipStatusWrite?: () => Promise<void>;
  },
): Promise<{ reactivated: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);

  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });

  await requireOrgMemberManager(prisma, { orgId: org.id, actorUserId, config: params.config });

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
    actor: params.actor,
    action: 'member.reactivated',
    targetType: 'org_member',
    targetId: member.id,
    metadata: { userId },
  });

  return { reactivated: true };
}
