import { findValidInviteLink } from './team-invite-link.lookup.js';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import {
  assertDatabaseEnabled,
  auditOrg,
  resolveOrgActor,
  resolveOrganisation,
  type OrgActorProvenance,
} from './organisation.service.base.js';
import {
  DAY_MS,
  TEAM_INVITE_LINK_SELECT,
  clampExpiresInDays,
  clampMaxUses,
  generateInviteLinkToken,
  normalizeInviteLinkRole,
  requireLinkManager,
  toInviteLinkRecord,
  type TeamInviteLinkRecord,
} from './team-invite-link.base.js';

// Phase 5 (design §4.7, §7 step 6, §8): shareable team invite links. A link authorizes JOINING a
// team, never AUTHENTICATION — redemption only happens on the verified-session path
// (`POST /auth/select-team`'s `inviteLinkToken`, after the `login_token` bridge proves the email
// was already verified). Only the token HASH is stored (mirrors `domain-secret.service.ts`'s
// claim-token pattern); the plaintext token is returned exactly once, at creation. The pure
// primitives (caps, role vocabulary, record shape, manager check) live in
// `team-invite-link.base.ts`.

export type { TeamInviteLinkRecord };

export type InviteLinkPrisma = PrismaClient;

export type InviteLinkDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: InviteLinkPrisma;
  now?: () => Date;
  sharedSecret?: string;
  generateToken?: () => string;
  hashToken?: typeof hashEmailToken;
};

/**
 * Create a shareable invite link. REJECTS (generic BAD_REQUEST) if the team's `joinPolicy` is
 * `HIDDEN` — invite links are refused where self-serve entry is forbidden (design §4.7).
 */
export async function createTeamInviteLink(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    roleToAssign?: string;
    maxUses?: number;
    expiresInDays?: number;
    config: ClientConfig;
  },
  deps?: InviteLinkDeps,
): Promise<{ token: string; link: TeamInviteLinkRecord }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const org = await resolveOrganisation(prisma, { orgId: params.orgId });

  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true, joinPolicy: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  await requireLinkManager(prisma, {
    orgId: org.id,
    teamId: team.id,
    actorUserId,
    config: params.config,
  });

  if (team.joinPolicy === 'HIDDEN') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const roleToAssign = normalizeInviteLinkRole(params.roleToAssign, params.config);
  const maxUses = clampMaxUses(params.maxUses);
  const expiresInDays = clampExpiresInDays(params.expiresInDays);
  const expiresAt = new Date(now.getTime() + expiresInDays * DAY_MS);

  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const generateToken = deps?.generateToken ?? generateInviteLinkToken;
  const hashToken = deps?.hashToken ?? hashEmailToken;
  const token = generateToken();
  const tokenHash = hashToken(token, sharedSecret);

  const created = await prisma.teamInviteLink.create({
    data: {
      orgId: org.id,
      teamId: team.id,
      tokenHash,
      // Nullable column: a link created in backend mode has no human creator, and
      // recording one would be a lie. The org audit row carries the backend's
      // provenance instead.
      createdByUserId: actorUserId ?? null,
      roleToAssign,
      expiresAt,
      maxUses,
    },
    select: TEAM_INVITE_LINK_SELECT,
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'invite_link.created',
    targetType: 'invite_link',
    targetId: created.id,
    metadata: { teamId: team.id, roleToAssign, maxUses },
  });

  return { token, link: toInviteLinkRecord(created) };
}

/** List every invite link for a team (including revoked ones — `revokedAt` tells the caller which). */
export async function listTeamInviteLinks(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config: ClientConfig;
  },
  deps?: InviteLinkDeps,
): Promise<{ data: TeamInviteLinkRecord[] }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });

  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  await requireLinkManager(prisma, {
    orgId: org.id,
    teamId: team.id,
    actorUserId,
    config: params.config,
  });

  const rows = await prisma.teamInviteLink.findMany({
    where: { orgId: org.id, teamId: team.id },
    orderBy: { createdAt: 'desc' },
    select: TEAM_INVITE_LINK_SELECT,
  });

  return { data: rows.map(toInviteLinkRecord) };
}

/** Revoke an invite link. Idempotent — revoking an already-revoked link is a no-op success. */
export async function revokeTeamInviteLink(
  params: {
    orgId: string;
    teamId: string;
    linkId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config: ClientConfig;
  },
  deps?: InviteLinkDeps,
): Promise<{ revoked: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const org = await resolveOrganisation(prisma, { orgId: params.orgId });
  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  await requireLinkManager(prisma, {
    orgId: org.id,
    teamId: team.id,
    actorUserId,
    config: params.config,
  });

  const link = await prisma.teamInviteLink.findFirst({
    where: { id: params.linkId, orgId: org.id, teamId: team.id },
    select: { id: true, revokedAt: true },
  });
  if (!link) {
    throw new AppError('NOT_FOUND', 404);
  }

  if (!link.revokedAt) {
    await prisma.teamInviteLink.update({
      where: { id: link.id },
      data: { revokedAt: now },
      select: { id: true },
    });
  }

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'invite_link.revoked',
    targetType: 'invite_link',
    targetId: link.id,
    metadata: { teamId: team.id },
  });

  return { revoked: true };
}

/**
 * Landing-page validation (Task 4, `GET /auth/team-invite-link/:token`) — checks the token WITHOUT
 * redeeming or mutating anything (no `useCount` increment). Throws the same generic error as
 * redemption; callers render the generic invalid-link page on any thrown error.
 */
export async function assertTeamInviteLinkValidForLanding(
  params: { token: string; domain: string },
  deps?: InviteLinkDeps,
): Promise<void> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const hashToken = deps?.hashToken ?? hashEmailToken;
  // Validates the token, not the product it was opened from: the team's org may belong to any
  // UOA-integrated product.
  void params.domain;
  const tokenHash = hashToken(params.token, sharedSecret);

  await findValidInviteLink(prisma, { tokenHash, now });
}

export {
  redeemTeamInviteLink,
  type RedeemTeamInviteLinkResult,
} from './team-invite-link.redemption.js';
