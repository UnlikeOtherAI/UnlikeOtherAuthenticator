import type { Prisma, PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';

export type AdminAuditAction =
  | 'user.team_added'
  | 'integration.accepted'
  | 'integration.declined'
  | 'integration.deleted'
  | 'integration.claim_resent'
  | 'jwk.added'
  | 'jwk.deactivated'
  | 'domain.disabled'
  | 'domain.enabled'
  | 'domain.secret_rotated'
  | 'domain.twofa_policy_updated'
  | 'organisation.twofa_policy_updated'
  | 'signature.agreement_created'
  | 'signature.agreement_updated'
  | 'signature.receipt_accessed'
  | 'signature.revoked'
  | 'signature.settings_updated'
  | 'signature.version_deleted'
  | 'signature.version_published'
  | 'signature.version_updated'
  | 'signature.version_uploaded'
  | 'signature.version_withdrawn'
  | 'billing.app_key_created'
  | 'billing.app_key_revoked'
  | 'billing.assignment_removed'
  | 'billing.assignment_upserted'
  | 'billing.default_tariff_changed'
  | 'billing.service_created'
  | 'billing.stripe_usage_exported'
  | 'billing.tariff_version_created'
  | 'confidential_delegation.created'
  | 'confidential_delegation.updated'
  | 'confidential_delegation.deleted'
  | 'team.avatar_updated'
  | 'team.avatar_deleted'
  | 'user.avatar_updated'
  | 'user.avatar_deleted'
  | 'user.twofa_reset'
  // `domain.*` = taken by an authenticated product backend over `/domain/*`, not by an operator.
  // `actorEmail` on these rows is a `client:` principal (see `machineActor`), never an address.
  | 'domain.user_avatar_updated'
  | 'domain.user_avatar_deleted'
  | 'domain.team_avatar_updated'
  | 'domain.team_avatar_deleted';

export type AuditLogPrisma = Pick<PrismaClient, 'adminAuditLog'>;

/**
 * The `actorEmail` value for an action taken by an authenticated machine rather than a person.
 *
 * `/internal/admin/*` rows name the operator who acted. `/domain/*` is authenticated by the
 * domain-hash bearer, which identifies a client backend and not a user, so there is no address to
 * record. The `client:` prefix keeps those rows unmistakable and unmatchable against any real
 * address, so a reader never mistakes a machine action for a human one.
 *
 * `clientDomainId` is `ClientDomain.id` — a plain row cuid. It must NEVER be
 * `request.domainAuthClientId`, which despite its name is the caller's **live domain-hash bearer**
 * (`verifyDomainAuthToken` returns `clientId: clientHash`, the token exactly as presented). Writing
 * that here would persist a full-system-trust credential in plaintext, in an operator-readable
 * table, under a column nobody would think to check for a secret — and it rotates with the domain
 * secret, so it would not even correlate the trail it exists to build.
 */
export function machineActor(params: { domain: string; clientDomainId?: string | null }): string {
  const client = params.clientDomainId ? `#${params.clientDomainId}` : '';
  return `client:${params.domain}${client}`;
}

function prismaClient(deps?: { prisma?: AuditLogPrisma }): AuditLogPrisma {
  return deps?.prisma ?? (getAdminPrisma() as unknown as AuditLogPrisma);
}

export async function writeAuditLog(
  params: {
    actorEmail: string;
    action: AdminAuditAction;
    targetDomain?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
  deps?: { prisma?: AuditLogPrisma },
): Promise<void> {
  await prismaClient(deps).adminAuditLog.create({
    data: {
      actorEmail: params.actorEmail,
      action: params.action,
      targetDomain: params.targetDomain ?? null,
      metadata: params.metadata ?? {},
    },
  });
}
