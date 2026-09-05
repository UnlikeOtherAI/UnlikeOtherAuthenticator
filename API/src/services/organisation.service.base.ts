import { Prisma, PrismaClient, type MembershipStatus } from '@prisma/client';

import type { OrgActorProvenance } from './org-audit-log.service.js';
import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import {
  avatarImageBaseUrl,
  domainAvatarImageUrl,
  domainTeamAvatarImageUrl,
} from '../utils/avatar-url.js';
import { getAppLogger } from '../utils/app-logger.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import {
  checkSlug,
  deriveSlugBase,
  isReservedLabel,
  randomSlugSuffix,
  withSlugSuffix,
} from '@unlikeotherai/slug';
import { parseIconUrl } from '../utils/http-url.js';
import {
  writeOrgAuditLog,
  type OrgAuditAction,
  type OrgAuditLogPrisma,
  type OrgAuditTargetType,
} from './org-audit-log.service.js';
import {
  configRoleHoldsCapability,
  resolveOrgRoleVocabulary,
  type UoaCapability,
} from './role-grants.js';

export { normalizeDomain };

// The two organisation resolvers live in their own file (this one is at the 500-line cap) but
// stay part of the base surface every org service imports.
export {
  resolveOrganisation,
  resolveOrganisationByDomain,
  type ResolvedOrganisationRow,
} from './organisation.resolve.js';

type OrgServicePrisma = PrismaClient & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};

type OrgServiceDeps = {
  env?: ReturnType<typeof getEnv>;
  prisma?: OrgServicePrisma;
  /**
   * Lets an authenticated continuation keep its organisation audit row inside
   * the same transaction as team creation and code issuance.
   */
  auditPrisma?: OrgAuditLogPrisma;
};

export type CursorList<T> = {
  data: T[];
  next_cursor: string | null;
};

export type OrgMemberInvitesValue = 'allowed' | 'admin_approval' | 'disabled';

const ALLOWED_MEMBER_INVITES_VALUES = new Set<OrgMemberInvitesValue>([
  'allowed',
  'admin_approval',
  'disabled',
]);

export function normalizeMemberInvitesSetting(value: string): OrgMemberInvitesValue {
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_MEMBER_INVITES_VALUES.has(normalized as OrgMemberInvitesValue)) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return normalized as OrgMemberInvitesValue;
}

/**
 * Validate the `icon_url` field shared by Team/Organisation writes (design §11.3, brief §15):
 * external URL only, no local storage. `undefined` = field omitted (leave the stored value
 * unchanged); `null` clears the icon; any other value must be an `https:` URL of at most 2048
 * characters, else a generic `BAD_REQUEST` (no user-visible error specificity per CLAUDE.md).
 * Single source of truth for both `updateOrganisation` and `updateTeam` — re-exported from
 * `team.service.base.ts`.
 */
export function normalizeIconUrl(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const parsed = parseIconUrl(value);
  if (!parsed) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return parsed;
}

export type OrganisationRecord = {
  id: string;
  domain: string;
  name: string;
  slug: string;
  ownerId: string;
  memberInvites: OrgMemberInvitesValue;
  iconUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OrganisationMemberRecord = {
  id: string;
  orgId: string;
  userId: string;
  avatarImageUrl: string;
  role: string;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Avatar image URL for a user named in an `/org/*` payload (Docs/Auth/avatars.md §9). The
 * `/org/*` family authenticates with the domain hash bearer (plus the caller's access token), so
 * the domain-hash form is exactly the credential class the caller already used. Shared by the org,
 * team, group, invite and access-request serializers so the shape is derived in one place.
 */
export function memberAvatarImageUrl(domain: string, userId: string): string {
  return domainAvatarImageUrl({ baseUrl: avatarImageBaseUrl(), domain, userId });
}

/**
 * Avatar image URL for a team ("company") named in an `/org/*` or `/internal/org/*` payload
 * (Docs/Auth/avatars.md §11). Same credential class as `memberAvatarImageUrl`: the domain-hash
 * bearer the caller already used.
 */
export function teamAvatarImageUrl(domain: string, teamId: string): string {
  return domainTeamAvatarImageUrl({ baseUrl: avatarImageBaseUrl(), domain, teamId });
}

// The label rules — length, charset, reserved words — live in
// `@unlikeotherai/slug`, because an organisation slug and a team slug are both
// DNS labels in the same hostname and may not disagree about what is legal.
const SLUG_RANDOM_SUFFIX_MAX_ATTEMPTS = 10;
const ORG_SLUG_FALLBACK = 'org';

/**
 * Resolve who is calling an `/org/*` service, and refuse to guess.
 *
 * Exactly one of two things is true on every `/org/*` call:
 *
 *   1. A signed-in user is acting. `actorUserId` is their id, and every per-user
 *      org/team role check in the service applies to them.
 *   2. The product backend for this domain is acting. `requireOrgRole` accepted
 *      the request on the domain pairing alone (domain-hash bearer + verified
 *      config JWT, no `X-UOA-Access-Token`), so there is NO acting user and the
 *      per-user role checks have no subject. `actorUserId` is `undefined` and
 *      `actor` names the backend.
 *
 * Anything else is a programming error — an `actorUserId` that went missing on a
 * user-initiated path would otherwise skip every actor check silently. That case
 * raises a 500 rather than degrading into unauthenticated access, so a future
 * refactor that drops the parameter fails loudly instead of opening a hole.
 *
 * An explicitly-empty `actorUserId` keeps its historical `BAD_REQUEST` — it is a
 * malformed value, not an absent one.
 */
export function resolveOrgActor(params: {
  actorUserId?: string;
  actor?: OrgActorProvenance;
}): string | undefined {
  // Both set is as unresolvable as neither: the two describe mutually exclusive
  // callers, and letting them through would write an audit row claiming that a
  // user AND the domain backend performed the same mutation. `orgCaller` only
  // ever produces one of the two, so this is a programming error on the same
  // footing as a dropped spread — and gets the same loud 500.
  if (params.actorUserId !== undefined && params.actor) {
    throw new AppError('INTERNAL', 500, 'ORG_ACTOR_AMBIGUOUS');
  }
  if (params.actorUserId !== undefined) {
    const trimmed = params.actorUserId.trim();
    if (!trimmed) throw new AppError('BAD_REQUEST', 400);
    return trimmed;
  }
  if (params.actor) return undefined;
  throw new AppError('INTERNAL', 500, 'ORG_ACTOR_UNRESOLVED');
}

export function assertDatabaseEnabled(env: ReturnType<typeof getEnv>): void {
  if (!env.DATABASE_URL) {
    throw new AppError('INTERNAL', 500, 'DATABASE_DISABLED');
  }
}

export function isP2002Error(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function isP2003Error(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

export function ensureOrgName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new AppError('BAD_REQUEST', 400);
  }
  return trimmed;
}

export function ensureOrgRole(role: string, allowedRoles: string[]): void {
  if (!allowedRoles.includes(role)) {
    throw new AppError('BAD_REQUEST', 400);
  }
}

/**
 * Require that the ACTING USER's org-scope role grants `capability`, per this domain's
 * `role_grants` table (`Docs/plans/2026-08-16-configurable-roles-and-capabilities.md` §3).
 *
 * Replaces the `role !== 'owner' && role !== 'admin'` comparisons the org services used to make,
 * so a role a domain invented can hold real authority here too. Three things are deliberate:
 *
 *  - **Org scope only.** `requireTeamCapability` (team services) unions org- and team-scope
 *    standing, because an org grant of a team-scope capability reaches down into every team. The
 *    reverse must not hold: administering one team cannot confer authority over the organisation
 *    that contains it, so nothing here reads a `TeamMember` row.
 *  - **Pure.** Every call site has already loaded the actor's ACTIVE membership for its own
 *    reasons, so the role is passed in rather than re-queried — this gate costs no extra round
 *    trip and cannot silently disagree with the row the caller then acts on.
 *  - **A missing membership is `undefined`/`null` and holds nothing.** Backend mode never reaches
 *    here at all: with no acting user the domain pairing already outranks every member role, which
 *    each caller states by guarding on `actorUserId`.
 */
export function requireOrgCapability(
  config: ClientConfig,
  capability: UoaCapability,
  actorRole: string | null | undefined,
): void {
  if (!configRoleHoldsCapability(config, 'org', actorRole, capability)) {
    throw new AppError('FORBIDDEN', 403);
  }
}

export function toListLimit(limit?: number): number {
  const resolved = limit == null ? 50 : Math.trunc(limit);
  if (!Number.isFinite(resolved) || resolved <= 0) return 1;
  return Math.min(200, resolved);
}

export function toOrganisationRecord(row: {
  id: string;
  domain: string;
  name: string;
  slug: string;
  ownerId: string;
  memberInvites?: string;
  iconUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): OrganisationRecord {
  return {
    id: row.id,
    domain: row.domain,
    name: row.name,
    slug: row.slug,
    ownerId: row.ownerId,
    memberInvites: (row.memberInvites ?? 'allowed') as OrgMemberInvitesValue,
    iconUrl: row.iconUrl ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMemberRecord(
  row: {
    id: string;
    orgId: string;
    userId: string;
    role: string;
    status: MembershipStatus;
    createdAt: Date;
    updatedAt: Date;
  },
  domain: string,
): OrganisationMemberRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    avatarImageUrl: memberAvatarImageUrl(domain, row.userId),
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Derive an available organisation slug from an organisation's name.
 *
 * Forgiving, deliberately, and the counterpart to `ensureAvailableOrgSlug`
 * below: a slug the product is *inventing* must always produce something, but
 * a slug a person *chose* is refused with a reason. Derivation used to reject —
 * an organisation named "团队" normalised to the empty string and 400'd, and one
 * named "API" was refused for holding a reserved word — which meant a legal
 * company name could not be registered because of a label nobody had asked to
 * see. Now the name is rendered as best it can be and disambiguated, exactly as
 * the team path does, and whoever cares about the address changes it.
 */
export function deriveSlugWithValidation(
  domain: string,
  prisma: Pick<OrgServicePrisma, 'organisation'>,
  name: string,
  existingSlugToIgnore?: string,
): Promise<string> {
  const base = deriveSlugBase(name, { fallback: ORG_SLUG_FALLBACK });
  return resolveUniqueSlugWithCollisionRetries(domain, prisma, base, existingSlugToIgnore);
}

/**
 * Validate an explicitly chosen organisation slug and confirm it is free.
 *
 * Uniqueness is per client domain, matching `@@unique([domain, slug])`, because
 * the organisation slug is the tenant's own DNS label under that product's base
 * domain — two organisations on one domain cannot share it the way two teams
 * inside one organisation can.
 */
export async function ensureAvailableOrgSlug(params: {
  domain: string;
  prisma: Pick<OrgServicePrisma, 'organisation'>;
  slug: string;
  existingSlugToIgnore?: string;
  reservedLabels?: Iterable<string>;
}): Promise<string> {
  const result = checkSlug(params.slug, { reserved: params.reservedLabels });
  if (!result.ok) {
    throw new AppError('BAD_REQUEST', 400, `ORG_SLUG_${result.reason.toUpperCase()}`);
  }

  if (result.slug === params.existingSlugToIgnore?.trim()) {
    return result.slug;
  }

  const existing = await params.prisma.organisation.findFirst({
    where: { domain: params.domain, slug: result.slug },
    select: { id: true },
  });
  if (existing) {
    throw new AppError('BAD_REQUEST', 400, 'ORG_SLUG_TAKEN');
  }

  return result.slug;
}

export async function resolveUniqueSlugWithCollisionRetries(
  domain: string,
  prisma: Pick<OrgServicePrisma, 'organisation'>,
  base: string,
  existingSlugToIgnore?: string,
  reservedLabels?: Iterable<string>,
): Promise<string> {
  const normalizedIgnore = existingSlugToIgnore?.trim();
  let candidate = base;

  for (let attempt = 0; attempt < SLUG_RANDOM_SUFFIX_MAX_ATTEMPTS; attempt++) {
    if (candidate === normalizedIgnore) {
      return candidate;
    }

    // A reserved label is unavailable in exactly the way a taken one is, so it
    // takes the same path: suffix and try again, rather than failing a
    // creation whose only fault is the company's name.
    const unavailable =
      isReservedLabel(candidate, reservedLabels) ||
      (await prisma.organisation.findFirst({
        where: { domain, slug: candidate },
        select: { id: true },
      })) !== null;
    if (!unavailable) return candidate;

    candidate = withSlugSuffix(base, randomSlugSuffix());
  }

  throw new AppError('INTERNAL', 500, 'ORG_SLUG_COLLISION_RETRY_EXHAUSTED');
}

export async function getOrganisationMember(
  prisma: OrgServicePrisma,
  params: { orgId: string; userId: string },
  opts?: { activeOnly?: boolean },
): Promise<{ id: string; orgId: string; userId: string; role: string } | null> {
  // `activeOnly` is used for ACTOR authorization (design §4.9: "a DEACTIVATED admin has no
  // powers") — a deactivated/removed member must not pass owner/admin checks even while their
  // pre-deactivation access token is still within its TTL. Target-member lookups omit it so a
  // DEACTIVATED/REMOVED member can still be found and, e.g., removed.
  return await prisma.orgMember.findFirst({
    where: {
      orgId: params.orgId,
      userId: params.userId,
      ...(opts?.activeOnly ? { status: 'ACTIVE' as MembershipStatus } : {}),
    },
    select: { id: true, orgId: true, userId: true, role: true },
  });
}

// Best-effort org audit write (design §4.10). Most callers omit `prisma` and write through the
// BYPASSRLS admin client after the primary mutation commits. Atomic flows may inject their current
// transaction so replay rollback also removes the audit row.
export async function auditOrg(
  params: {
    orgId: string;
    /** The acting org member, or `undefined` when a trusted backend acted (see `actor`). */
    actorUserId: string | undefined;
    /**
     * The trusted backend that made this mutation. Undefined for
     * organisation-member mutations.
     */
    actor?: OrgActorProvenance;
    action: OrgAuditAction;
    targetType: OrgAuditTargetType;
    targetId: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
  deps?: { prisma?: OrgAuditLogPrisma },
): Promise<void> {
  try {
    await writeOrgAuditLog(
      {
        orgId: params.orgId,
        actorUserId: params.actorUserId,
        ...(params.actor ? { actor: params.actor } : {}),
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        metadata: params.metadata ?? {},
      },
      deps,
    );
  } catch (err) {
    // The mutation has already committed, so throwing here would report failure
    // for work that actually happened — worse than a missing audit row. But a
    // silent `catch {}` also makes "no audit row" indistinguishable from "no
    // mutation", which is exactly the wrong answer for an authentication
    // service. Log loudly and distinctly instead, so a dropped row is
    // greppable and alertable rather than invisible.
    //
    // In backend mode this row is the ONLY record of the verified backend actor,
    // so treat a failure here as an operational incident, not noise.
    try {
      getAppLogger().error(
        {
          err,
          orgId: params.orgId,
          action: params.action,
          targetType: params.targetType,
          targetId: params.targetId,
          actorUserId: params.actorUserId ?? null,
          actorVia: params.actor?.via ?? null,
          actorSourceDomain:
            params.actor?.via === 'domain_backend' ? params.actor.sourceDomain : null,
          actorAdminUserId:
            params.actor?.via === 'admin_superuser' ? params.actor.userId : null,
          actorAdminEmail:
            params.actor?.via === 'admin_superuser' ? params.actor.email : null,
        },
        'org_audit_log_write_failed',
      );
    } catch {
      // `getAppLogger` throws when there is no running server to log through —
      // a unit test or a CLI entry point. There is no operator to alert in that
      // case, and the audit row is not the artefact under test.
    }
  }
}

export function parseOrgLimit(config: ClientConfig): number {
  return config.org_features?.max_members_per_org ?? 1000;
}

/**
 * This domain's org-role vocabulary. One reader, shared with the grant resolver — there used to be
 * a second copy of the `org_roles ?? ['owner','admin','member']` fallback here, and two readers of
 * one config key is exactly how a vocabulary and the table validated against it drift apart.
 */
export function parseOrgFeatureRoles(config: ClientConfig): string[] {
  return resolveOrgRoleVocabulary(config);
}

export type { OrgActorProvenance, OrgServicePrisma, OrgServiceDeps };
