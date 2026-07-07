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
  | 'organisation';

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
  | 'org.member_invites_changed';

export type OrgAuditLogPrisma = Pick<PrismaClient, 'orgAuditLog'>;

export type WriteOrgAuditLogParams = {
  orgId: string;
  action: OrgAuditAction;
  targetType: OrgAuditTargetType;
  targetId: string;
  actorUserId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

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
      metadata: params.metadata ?? {},
    },
  });
}
