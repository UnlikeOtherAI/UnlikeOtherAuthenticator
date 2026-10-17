import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { currentSessionAssurance, validateSessionAssurance, type AssuranceDb } from './session-assurance.service.js';

export async function enterpriseReadiness(clientDomain: string, db = getAdminPrisma()) {
  const product = await db.enterpriseProductReadiness.findUnique({ where: { clientDomain } });
  const blockers: string[] = [];
  if (product?.minimumAssuranceVersion !== 1) blockers.push('ASSURANCE_CONTRACT_REQUIRED');
  if (!product?.authorityMigrationRevision) blockers.push('NESSIE_AUTHORITY_MIGRATION_REQUIRED');
  if (!product?.revocationConsumersRevision) blockers.push('REVOCATION_CONSUMERS_REQUIRED');
  const activationAllowed = blockers.length === 0;
  // Recovery approval is deliberately not implied by a database string. The design is unresolved.
  blockers.push('RECOVERY_DESIGN_REQUIRED');
  return { activation_allowed: activationAllowed, enforcement_allowed: false, blockers };
}

/** The direct lookup invokes this seam too: callers cannot bypass policy via a lower-level helper. */
export async function assertOrgAccessPolicy(
  binding: { userId: string; domain: string; orgId: string; assuranceId?: string },
  db: AssuranceDb & Pick<PrismaClient, 'organisationEmailDomain'> = getAdminPrisma(),
): Promise<void> {
  const policy = await db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: {
    clientDomain: binding.domain, orgId: binding.orgId,
  } } });
  if (!policy || policy.enforcement === 'off') return;
  let governed = policy.enforcement === 'required_for_all_members';
  if (!governed) {
    const user = await db.user.findUnique({ where: { id: binding.userId }, select: { email: true } });
    const emailDomain = user?.email?.split('@')[1]?.toLowerCase();
    // Lapsed/revoked claims remain governed: DNS loss cannot become a password bypass.
    governed = Boolean(emailDomain && await db.organisationEmailDomain.findFirst({ where: {
      clientDomain: binding.domain, orgId: binding.orgId, emailDomain,
      verifiedAt: { not: null },
    }, select: { id: true } }));
  }
  if (!governed) return;
  const proof = binding.assuranceId ? await db.sessionAssurance.findUnique({ where: { id: binding.assuranceId } }) : currentSessionAssurance();
  if (!proof || proof.userId !== binding.userId || proof.clientDomain !== binding.domain ||
    proof.orgId !== binding.orgId || proof.method !== 'sso') {
    throw new AppError('FORBIDDEN', 403, 'SSO_TEAM_REAUTH_REQUIRED');
  }
  await validateSessionAssurance({ id: proof.id, userId: binding.userId,
    clientDomain: binding.domain, orgId: binding.orgId, teamId: proof.teamId,
    credentialEpoch: proof.credentialEpoch }, db);
}
