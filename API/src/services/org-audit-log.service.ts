import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';

/**
 * Org-scoped audit log (design §4.10). Distinct from the platform-admin `AdminAuditLog`
 * (audit-log.service.ts), which is keyed by operator email for `/internal/admin/*` actions.
 *
 * Rows are written from membership / invite / policy mutations. Two write paths:
 *
 *   1. Tenant-scoped write — pass the request's transaction client (`prisma`). The row is inserted
 *      in the SAME transaction as the mutation it records, under the uoa_app role. RLS requires
 *      `org_id` to equal the request's `app.org_id`, so only pass the tx client for a mutation that
 *      is already scoped to `orgId`.
 *   2. System write — omit `prisma`. Uses the BYPASSRLS admin client for actions with no tenant
 *      context (auto-enrolment, later SCIM), where `actorUserId` is null.
 */

export type OrgAuditTargetType =
  | 'org_member'
  | 'team_member'
  | 'invite'
  | 'invite_link'
  | 'team'
  | 'organisation'
  | 'access_request';

export type OrgAuditAction =
  // Membership lifecycle (§4.5)
  | 'member.added'
  | 'member.removed'
  | 'member.role_changed'
  | 'member.deactivated'
  | 'member.reactivated'
  | 'team_member.added'
  | 'team_member.removed'
  | 'team_member.role_changed'
  // Invites (§4.7)
  | 'invite.created'
  | 'invite.resent'
  | 'invite.revoked'
  | 'invite.accepted'
  | 'invite.declined'
  | 'invite.approved'
  | 'invite.denied'
  | 'invite_link.created'
  | 'invite_link.revoked'
  // Policy / settings (§4.6)
  | 'team.join_policy_changed'
  | 'org.member_invites_changed'
  // Organisation, team and access-request lifecycle. Every one of these is
  // reachable in backend mode (brief §24.8), where there is no acting user and
  // the audit row's `uoa_actor` provenance is the ONLY record of who acted.
  | 'org.created'
  | 'org.updated'
  | 'org.deleted'
  | 'org.ownership_transferred'
  | 'team.created'
  | 'team.updated'
  | 'team.deleted'
  | 'access_request.approved'
  | 'access_request.rejected';

export type OrgAuditLogPrisma = Pick<PrismaClient, 'orgAuditLog'>;

/**
 * Provenance of a trusted backend actor making an organisation mutation rather
 * than a signed-in organisation member making it.
 *
 * `undefined` means user-initiated — the shape every request carrying an
 * `x-uoa-access-token` produces, and the only shape that existed before backend
 * mode. It is populated exactly when `requireOrgRole` accepted the request on the
 * domain pairing alone (domain-hash bearer + verified config JWT, no user token);
 * see `middleware/org-role-guard.ts`.
 *
 * There is no acting organisation member in either backend mode, so an audit row
 * carries `actorUserId: null` and this provenance instead. Admin provenance names
 * the verified platform superuser without treating them as an org member.
 */
export type OrgActorProvenance =
  | {
      via: 'domain_backend';
      /** The verified config domain the calling backend was authenticated as. */
      sourceDomain: string;
    }
  | {
      via: 'admin_superuser';
      /** Stable UOA subject and display identity from the verified admin access token. */
      userId: string;
      email: string;
    };

export type WriteOrgAuditLogParams = {
  orgId: string;
  action: OrgAuditAction;
  targetType: OrgAuditTargetType;
  targetId: string;
  actorUserId?: string | null;
  /**
   * Provenance of the trusted backend actor that made this mutation. Undefined
   * for organisation-member mutations carrying an `x-uoa-access-token`.
   */
  actor?: OrgActorProvenance;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Reserved `metadata` key holding trusted backend-actor provenance.
 *
 * `OrgAuditLog` has no dedicated actor column and adding one would mean a schema
 * migration on a production auth service; `metadata` is already a `Json` column
 * with a `{}` default, so provenance rides there under one reserved key. Rows
 * without the key are organisation-member initiated — including every row
 * written before backend provenance existed, which stays true without a backfill.
 */
export const ORG_AUDIT_ACTOR_METADATA_KEY = 'uoa_actor';

/** Serialise actor provenance into the reserved metadata key. */
function actorMetadata(
  actor: OrgActorProvenance | undefined,
): Record<string, Prisma.InputJsonValue> | undefined {
  if (!actor) return undefined;
  if (actor.via === 'admin_superuser') {
    return {
      [ORG_AUDIT_ACTOR_METADATA_KEY]: {
        via: actor.via,
        user_id: actor.userId,
        email: actor.email,
      },
    };
  }
  return {
    [ORG_AUDIT_ACTOR_METADATA_KEY]: {
      via: actor.via,
      source_domain: actor.sourceDomain,
    },
  };
}

/**
 * Merge caller metadata with actor provenance.
 *
 * Callers always pass a plain object, but `Prisma.InputJsonValue` also admits
 * scalars and arrays, so guard before spreading and fall back to the provenance
 * alone rather than silently discarding it.
 */
function buildMetadata(params: WriteOrgAuditLogParams): Prisma.InputJsonValue {
  const provenance = actorMetadata(params.actor);
  const base = params.metadata ?? {};
  if (!provenance) return base;
  const isPlainObject = typeof base === 'object' && base !== null && !Array.isArray(base);
  // Provenance last so caller metadata can never shadow the reserved key.
  return isPlainObject
    ? { ...(base as Record<string, Prisma.InputJsonValue>), ...provenance }
    : provenance;
}

/**
 * Write an org audit row. Pass `deps.prisma` (the tenant transaction client) to record it inside a
 * scoped mutation; omit it for a system write via the BYPASSRLS admin client.
 */
export async function writeOrgAuditLog(
  params: WriteOrgAuditLogParams,
  deps?: { prisma?: OrgAuditLogPrisma },
): Promise<void> {
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgAuditLogPrisma);

  await prisma.orgAuditLog.create({
    data: {
      orgId: params.orgId,
      actorUserId: params.actorUserId ?? null,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: buildMetadata(params),
    },
  });
}
