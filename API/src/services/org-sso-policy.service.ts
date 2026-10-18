import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { currentSessionAssurance, validateSessionAssurance, type AssuranceDb } from './session-assurance.service.js';
import { requireAuthenticationEvidence } from './authentication-evidence.service.js';
import { recoveryReadiness } from './enterprise-recovery-policy.service.js';

export async function enterpriseReadiness(clientDomain: string, db = getAdminPrisma(), orgId?: string) {
  const product = await db.enterpriseProductReadiness.findUnique({ where: { clientDomain } });
  const blockers: string[] = [];
  if (product?.minimumAssuranceVersion !== 1) blockers.push('ASSURANCE_CONTRACT_REQUIRED');
  if (!product?.authorityMigrationRevision) blockers.push('NESSIE_AUTHORITY_MIGRATION_REQUIRED');
  if (!product?.revocationConsumersRevision) blockers.push('REVOCATION_CONSUMERS_REQUIRED');
  if (orgId) {
    const policy = await db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: { clientDomain, orgId } } });
    if (!policy?.arrangementEnabled) blockers.push('CUSTOM_ARRANGEMENT_REQUIRED');
  }
  blockers.push('LIVE_IDENTITY_FLOW_REQUIRED');
  const activationAllowed = blockers.length === 0;
  const recovery = orgId ? await recoveryReadiness(clientDomain, orgId, db) : null;
  if (!recovery?.setup_complete) blockers.push('RECOVERY_SETUP_REQUIRED');
  else if (!recovery.drill_complete) blockers.push('RECOVERY_DRILL_REQUIRED');
  return { activation_allowed: activationAllowed, enforcement_allowed: activationAllowed && Boolean(recovery?.drill_complete), blockers };
}

/** The direct lookup invokes this seam too: callers cannot bypass policy via a lower-level helper. */
export async function assertOrgAccessPolicy(
  binding: { userId: string; domain: string; orgId: string; assuranceId?: string; authenticationEvidenceId?: string },
  db: AssuranceDb & Pick<PrismaClient, 'organisationEmailDomain'> = getAdminPrisma(),
): Promise<void> {
  let evidence: Awaited<ReturnType<typeof requireAuthenticationEvidence>> | undefined;
  if (binding.authenticationEvidenceId) {
    const user = await db.user.findUnique({ where: { id: binding.userId }, select: { tokenVersion: true } });
    if (!user) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
    evidence = await requireAuthenticationEvidence({ id: binding.authenticationEvidenceId,
      userId: binding.userId, credentialEpoch: user.tokenVersion, clientDomain: binding.domain }, db as PrismaClient);
    if (evidence.purpose !== 'authorize' || (evidence.provenance !== 'independent' && evidence.orgId !== binding.orgId)) {
      throw new AppError('FORBIDDEN', 403, 'SSO_TEAM_REAUTH_REQUIRED');
    }
  }
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
  if (evidence?.provenance === 'sso' && evidence.orgId === binding.orgId) return;
  const proof = binding.assuranceId ? await db.sessionAssurance.findUnique({ where: { id: binding.assuranceId } }) : currentSessionAssurance();
  if (!proof || proof.userId !== binding.userId || proof.clientDomain !== binding.domain ||
    proof.orgId !== binding.orgId || proof.method !== 'sso') {
    throw new AppError('FORBIDDEN', 403, 'SSO_TEAM_REAUTH_REQUIRED');
  }
  await validateSessionAssurance({ id: proof.id, userId: binding.userId,
    clientDomain: binding.domain, orgId: binding.orgId, teamId: proof.teamId,
    credentialEpoch: proof.credentialEpoch }, db);
}
