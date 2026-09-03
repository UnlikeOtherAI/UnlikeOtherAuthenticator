import { randomBytes } from 'node:crypto';

import type { ClientConfig } from './config.service.js';
import { AppError } from '../utils/errors.js';
import { hasTeamCapability, normalizeTeamRole } from './team.service.base.js';
import type { InviteLinkPrisma } from './team-invite-link.service.js';

// Shape, caps and vocabulary for shareable team invite links (design §4.7). Split out of
// `team-invite-link.service.ts` to keep that file under the 500-line cap; these are the pure
// primitives it composes — no database reads of its own beyond the shared capability check.

const MAX_EXPIRES_IN_DAYS = 30;
const DEFAULT_EXPIRES_IN_DAYS = 30;
const MAX_USES_CAP = 400;
const DEFAULT_MAX_USES = 400;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const TEAM_INVITE_LINK_SELECT = {
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

export function toInviteLinkRecord(row: TeamInviteLinkRow): TeamInviteLinkRecord {
  return { ...row };
}

export function generateInviteLinkToken(): string {
  // 32 bytes -> 256 bits of entropy; base64url for safe transport in URLs (mirrors
  // utils/verification-token.ts's generateEmailToken).
  return randomBytes(32).toString('base64url');
}

// Invite links may assign any role in the domain's configured team vocabulary — never "owner"
// (design §4.7 Task 2). Before `team_roles` was configurable this read `member | admin`, which is
// the same answer for the default vocabulary and the wrong one for a domain that named its own.
export function normalizeInviteLinkRole(value: string | undefined, config: ClientConfig): string {
  const role = normalizeTeamRole(value?.trim() || undefined, config);
  if (role === 'owner') {
    throw new AppError('BAD_REQUEST', 400);
  }
  return role;
}

export function clampExpiresInDays(value?: number): number {
  if (value === undefined) return DEFAULT_EXPIRES_IN_DAYS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return Math.min(Math.trunc(value), MAX_EXPIRES_IN_DAYS);
}

export function clampMaxUses(value?: number): number {
  if (value === undefined) return DEFAULT_MAX_USES;
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return Math.min(Math.trunc(value), MAX_USES_CAP);
}

/**
 * Actor must hold `members.manage` in this team (design §4.9/Phase 2).
 * Delegates to the shared `hasTeamCapability` boolean check (`team.service.base.ts`) — single
 * source of truth, also used by the gap-fix A "Invited" tab gate.
 */
export async function requireLinkManager(
  prisma: InviteLinkPrisma,
  params: {
    orgId: string;
    teamId: string;
    actorUserId: string | undefined;
    config: ClientConfig;
  },
): Promise<void> {
  const isManager = await hasTeamCapability(prisma, 'members.manage', params);
  if (!isManager) {
    throw new AppError('FORBIDDEN', 403);
  }
}
