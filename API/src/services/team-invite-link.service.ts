import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from './config.service.js';
import { getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { hashEmailToken } from '../utils/verification-token.js';
import {
  assertDatabaseEnabled,
  auditOrg,
  normalizeDomain,
  resolveOrganisationByDomain,
} from './organisation.service.base.js';
import { isOrgOrTeamManager } from './team.service.base.js';

// Phase 5 (design §4.7, §7 step 6, §8): shareable team invite links. A link authorizes JOINING a
// team, never AUTHENTICATION — redemption only happens on the verified-session path
// (`POST /auth/select-team`'s `inviteLinkToken`, after the `login_token` bridge proves the email
// was already verified). Only the token HASH is stored (mirrors `domain-secret.service.ts`'s
// claim-token pattern); the plaintext token is returned exactly once, at creation.

export type InviteLinkPrisma = PrismaClient;

export type InviteLinkDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: InviteLinkPrisma;
  now?: () => Date;
  sharedSecret?: string;
  generateToken?: () => string;
  hashToken?: typeof hashEmailToken;
};

const MAX_EXPIRES_IN_DAYS = 30;
const DEFAULT_EXPIRES_IN_DAYS = 30;
const MAX_USES_CAP = 400;
const DEFAULT_MAX_USES = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

const TEAM_INVITE_LINK_SELECT = {
  id: true,
  roleToAssign: true,
  expiresAt: true,
  maxUses: true,
  useCount: true,
  revokedAt: true,
  createdAt: true,
} as const;

type TeamInviteLinkRow = {
  id: string;
  roleToAssign: string;
  expiresAt: Date;
  maxUses: number;
  useCount: number;
  revokedAt: Date | null;
  createdAt: Date;
};

export type TeamInviteLinkRecord = TeamInviteLinkRow;

function toInviteLinkRecord(row: TeamInviteLinkRow): TeamInviteLinkRecord {
  return { ...row };
}

function generateInviteLinkToken(): string {
  // 32 bytes -> 256 bits of entropy; base64url for safe transport in URLs (mirrors
  // utils/verification-token.ts's generateEmailToken).
  return randomBytes(32).toString('base64url');
}

// Invite links may only assign "member" or "admin" — never "owner" (design §4.7 Task 2).
function normalizeInviteLinkRole(value?: string): string {
  const role = value?.trim() || 'member';
  if (role !== 'member' && role !== 'admin') {
    throw new AppError('BAD_REQUEST', 400);
  }
  return role;
}

function clampExpiresInDays(value?: number): number {
  if (value === undefined) return DEFAULT_EXPIRES_IN_DAYS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return Math.min(Math.trunc(value), MAX_EXPIRES_IN_DAYS);
}

function clampMaxUses(value?: number): number {
  if (value === undefined) return DEFAULT_MAX_USES;
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return Math.min(Math.trunc(value), MAX_USES_CAP);
}

/**
 * Actor must be an ACTIVE org owner/admin OR an ACTIVE team owner/admin (design §4.9/Phase 2).
 * Delegates to the shared `isOrgOrTeamManager` boolean check (`team.service.base.ts`) — single
 * source of truth, also used by the gap-fix A "Invited" tab gate.
 */
async function requireLinkManager(
  prisma: InviteLinkPrisma,
  params: { orgId: string; teamId: string; actorUserId: string },
): Promise<void> {
  const isManager = await isOrgOrTeamManager(prisma, params);
  if (!isManager) {
    throw new AppError('FORBIDDEN', 403);
  }
}

/**
 * Create a shareable invite link. REJECTS (generic BAD_REQUEST) if the team's `joinPolicy` is
 * `HIDDEN` — invite links are refused where self-serve entry is forbidden (design §4.7).
 */
export async function createTeamInviteLink(
  params: {
    orgId: string;
    teamId: string;
    domain: string;
    actorUserId: string;
    roleToAssign?: string;
    maxUses?: number;
    expiresInDays?: number;
    config: ClientConfig;
  },
  deps?: InviteLinkDeps,
): Promise<{ token: string; link: TeamInviteLinkRecord }> {
  void params.config;
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const org = await resolveOrganisationByDomain(prisma, { orgId: params.orgId, domain: params.domain });

  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true, joinPolicy: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  await requireLinkManager(prisma, { orgId: org.id, teamId: team.id, actorUserId: params.actorUserId });

  if (team.joinPolicy === 'HIDDEN') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const roleToAssign = normalizeInviteLinkRole(params.roleToAssign);
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
      createdByUserId: params.actorUserId,
      roleToAssign,
      expiresAt,
      maxUses,
    },
    select: TEAM_INVITE_LINK_SELECT,
  });

  await auditOrg({
    orgId: org.id,
    actorUserId: params.actorUserId,
    action: 'invite_link.created',
    targetType: 'invite_link',
    targetId: created.id,
    metadata: { teamId: team.id, roleToAssign, maxUses },
  });

  return { token, link: toInviteLinkRecord(created) };
}

/** List every invite link for a team (including revoked ones — `revokedAt` tells the caller which). */
export async function listTeamInviteLinks(
  params: { orgId: string; teamId: string; domain: string; actorUserId: string },
  deps?: InviteLinkDeps,
): Promise<{ data: TeamInviteLinkRecord[] }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const org = await resolveOrganisationByDomain(prisma, { orgId: params.orgId, domain: params.domain });

  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  await requireLinkManager(prisma, { orgId: org.id, teamId: team.id, actorUserId: params.actorUserId });

  const rows = await prisma.teamInviteLink.findMany({
    where: { orgId: org.id, teamId: team.id },
    orderBy: { createdAt: 'desc' },
    select: TEAM_INVITE_LINK_SELECT,
  });

  return { data: rows.map(toInviteLinkRecord) };
}

/** Revoke an invite link. Idempotent — revoking an already-revoked link is a no-op success. */
export async function revokeTeamInviteLink(
  params: { orgId: string; teamId: string; linkId: string; domain: string; actorUserId: string },
  deps?: InviteLinkDeps,
): Promise<{ revoked: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const now = deps?.now ? deps.now() : new Date();

  const org = await resolveOrganisationByDomain(prisma, { orgId: params.orgId, domain: params.domain });
  const team = await prisma.team.findFirst({
    where: { id: params.teamId, orgId: org.id },
    select: { id: true },
  });
  if (!team) {
    throw new AppError('NOT_FOUND', 404);
  }

  await requireLinkManager(prisma, { orgId: org.id, teamId: team.id, actorUserId: params.actorUserId });

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
    actorUserId: params.actorUserId,
    action: 'invite_link.revoked',
    targetType: 'invite_link',
    targetId: link.id,
    metadata: { teamId: team.id },
  });

  return { revoked: true };
}

type InviteLinkLookupPrisma = {
  teamInviteLink: Pick<PrismaClient['teamInviteLink'], 'findUnique'>;
  team: Pick<PrismaClient['team'], 'findFirst'>;
};

type InviteLinkLookup = {
  id: string;
  orgId: string;
  teamId: string;
  roleToAssign: string;
  maxUses: number;
  useCount: number;
  revokedAt: Date | null;
  expiresAt: Date;
};

/**
 * Shared validity lookup for both the landing check (Task 4) and redemption (Task 2). Every
 * failure — unknown token, revoked, expired, over-cap, cross-domain, or a HIDDEN team — throws the
 * SAME generic error so there is no oracle on which specific condition failed.
 */
async function findValidInviteLink(
  prisma: InviteLinkLookupPrisma,
  params: { tokenHash: string; domain: string; now: Date },
): Promise<{ link: InviteLinkLookup; team: { id: string; orgId: string } }> {
  const link = await prisma.teamInviteLink.findUnique({
    where: { tokenHash: params.tokenHash },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      roleToAssign: true,
      maxUses: true,
      useCount: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!link) throw new AppError('BAD_REQUEST', 400);
  if (link.revokedAt) throw new AppError('BAD_REQUEST', 400);
  if (link.expiresAt.getTime() <= params.now.getTime()) throw new AppError('BAD_REQUEST', 400);
  if (link.useCount >= link.maxUses) throw new AppError('BAD_REQUEST', 400);

  const team = await prisma.team.findFirst({
    where: { id: link.teamId, orgId: link.orgId, org: { domain: params.domain } },
    select: { id: true, orgId: true, joinPolicy: true },
  });
  if (!team) throw new AppError('BAD_REQUEST', 400);
  if (team.joinPolicy === 'HIDDEN') throw new AppError('BAD_REQUEST', 400);

  return { link, team: { id: team.id, orgId: team.orgId } };
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
  const domain = normalizeDomain(params.domain);
  const tokenHash = hashToken(params.token, sharedSecret);

  await findValidInviteLink(prisma, { tokenHash, domain, now });
}

export type RedeemTeamInviteLinkResult = { teamId: string; orgId: string };

/**
 * The core join (Task 2). Only ever called on the verified-session path
 * (`POST /auth/select-team`, after the `login_token` bridge proves the email was already
 * verified) — a link never grants membership on its own. Atomically increments `useCount` with a
 * conditional `updateMany` (`useCount: { lt: maxUses }`) so concurrent redemptions can never push
 * `useCount` past `maxUses`.
 */
export async function redeemTeamInviteLink(
  params: { token: string; userId: string; domain: string; config: ClientConfig },
  deps?: InviteLinkDeps,
): Promise<RedeemTeamInviteLinkResult> {
  void params.config;
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const prisma = deps?.prisma ?? (getPrisma() as InviteLinkPrisma);
  const now = deps?.now ? deps.now() : new Date();
  const sharedSecret = deps?.sharedSecret ?? requireEnv('SHARED_SECRET').SHARED_SECRET;
  const hashToken = deps?.hashToken ?? hashEmailToken;
  const domain = normalizeDomain(params.domain);
  const tokenHash = hashToken(params.token, sharedSecret);

  const result = await runInTransaction(prisma, async (tx) => {
    const { link, team } = await findValidInviteLink(tx, { tokenHash, domain, now });

    // Atomic cap guard: only ONE concurrent redemption can win when useCount is one below
    // maxUses. `link.maxUses` is immutable (never updated after creation), so comparing against
    // the snapshot value read above is safe.
    const claimed = await tx.teamInviteLink.updateMany({
      where: {
        id: link.id,
        revokedAt: null,
        expiresAt: { gt: now },
        useCount: { lt: link.maxUses },
      },
      data: { useCount: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new AppError('BAD_REQUEST', 400);
    }

    // Ensure org membership first, respecting one-org-per-domain (mirrors
    // acceptTeamInviteWithinTransaction in team-invite.service.acceptance.ts).
    const existingMembershipInDomain = await tx.orgMember.findFirst({
      where: { userId: params.userId, org: { domain } },
      select: { id: true, orgId: true },
    });
    if (existingMembershipInDomain && existingMembershipInDomain.orgId !== team.orgId) {
      throw new AppError('BAD_REQUEST', 400);
    }
    if (!existingMembershipInDomain) {
      await tx.orgMember.create({
        data: { orgId: team.orgId, userId: params.userId, role: 'member' },
        select: { id: true },
      });
    }

    // Add/reactivate the ACTIVE TeamMember row (Phase 2 lifecycle semantics). Idempotent when
    // already an ACTIVE member — the join still succeeds and returns the team.
    const existingTeamMembership = await tx.teamMember.findFirst({
      where: { teamId: team.id, userId: params.userId },
      select: { id: true, status: true },
    });

    let teamMemberId: string;
    if (!existingTeamMembership) {
      const created = await tx.teamMember.create({
        data: { teamId: team.id, userId: params.userId, teamRole: link.roleToAssign },
        select: { id: true },
      });
      teamMemberId = created.id;
    } else {
      teamMemberId = existingTeamMembership.id;
      if (existingTeamMembership.status !== 'ACTIVE') {
        await tx.teamMember.update({
          where: { id: existingTeamMembership.id },
          data: { status: 'ACTIVE', statusChangedAt: now, teamRole: link.roleToAssign },
        });
      }
    }

    return { teamId: team.id, orgId: team.orgId, teamMemberId };
  });

  await auditOrg({
    orgId: result.orgId,
    actorUserId: params.userId,
    action: 'team_member.added',
    targetType: 'team_member',
    targetId: result.teamMemberId,
    metadata: { teamId: result.teamId, via: 'invite_link' },
  });

  return { teamId: result.teamId, orgId: result.orgId };
}
