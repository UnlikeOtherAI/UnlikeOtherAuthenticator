import type { MachineAuthorization, MachineEnrollment, PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { isActiveUser } from './entity-lifecycle.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { resolveProductTeamPolicy } from './product-team-policy.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockTeamMembershipRows } from './team-scope.service.js';
import { activeTeamAuthorityWhere } from './organisation-team-authority.service.js';
import { assertIndependentSourceStillAdmitted } from './credential-admission.service.js';
import { assertEnterpriseProvisioningActive } from './enterprise-identity-status.service.js';
import { assertNotBannedAtLogin } from './ban-policy.service.js';
import { machineRefused } from './machine-crypto.js';
import { MACHINE_CREDENTIAL_MS, MACHINE_RECHECK_MS, MachineBinding, type MachineReasonCode } from './machine-contract.js';

export type MachineDb = PrismaClient;
export async function machineClock(db: MachineDb): Promise<Date> {
  const [row] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return row.now;
}
export async function machineBoundary<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof AppError) throw error;
    // Never log or return database errors containing bound credentials or proof payloads.
    machineRefused(503, 'MACHINE_AUTHORITY_UNAVAILABLE');
  }
}
export function machineTransaction<T>(run: (tx: MachineDb) => Promise<T>, db = getAdminPrisma()): Promise<T> {
  return machineBoundary(() => runInTransaction(db, run));
}
export async function requireMachineProduct(domain: string, tx: MachineDb): Promise<void> {
  const policy = await resolveProductTeamPolicy({ domain }, { prisma: tx });
  if (policy.scope !== 'all_active_memberships' || policy.product !== 'nessie') {
    machineRefused(403, 'MACHINE_PRODUCT_UNAVAILABLE');
  }
}
export function machineBinding(row: MachineEnrollment) {
  return { subject: row.subject, audience: row.audience, organization_id: row.orgId,
    team_id: row.teamId, purpose: 'computer_connection' as const, binding_id: row.bindingId };
}
export function assertMachineBinding(row: MachineEnrollment, value: unknown): void {
  if (JSON.stringify(MachineBinding.strip().parse(value)) !== JSON.stringify(machineBinding(row))) machineRefused();
}
export async function lockMachine(domain: string, id: string, tx: MachineDb): Promise<MachineEnrollment> {
  await lockProductTeamPolicyShared(tx);
  let row = await tx.machineEnrollment.findUnique({ where: { id } });
  if (!row || row.clientDomain !== domain) machineRefused();
  await lockRefreshSessionUserDomain({ userId: row.subject, domain }, { prisma: tx });
  await lockTeamMembershipRows({ userId: row.subject, orgId: row.orgId, teamId: row.teamId }, { prisma: tx });
  await tx.$queryRaw`SELECT id FROM machine_enrollments WHERE id=${id}::uuid FOR UPDATE`;
  row = await tx.machineEnrollment.findUnique({ where: { id } });
  if (!row || row.clientDomain !== domain) machineRefused();
  return row;
}
export async function currentMachineAuthorization(row: MachineEnrollment, tx: MachineDb): Promise<MachineAuthorization> {
  const auth = await tx.machineAuthorization.findUnique({ where: { id: row.currentAuthorizationId } });
  if (!auth || auth.enrollmentId !== row.id) machineRefused(409, 'MACHINE_LINEAGE_INVALID');
  return auth;
}
export async function stopMachine(row: MachineEnrollment, status: string, reason: MachineReasonCode, tx: MachineDb) {
  const terminal = ['device_revoked', 'all_devices_revoked', 'credential_replay', 'lineage_invalid'];
  if (terminal.includes(row.reason)) return row;
  // Proven theft/corruption retires a held/reset grant too. Otherwise a later
  // lawful reauthorization could reuse a grant whose lineage was already unsafe.
  const retiring = status === 'revoked' && terminal.includes(reason);
  if (!retiring && row.status !== 'allowed' &&
    !(row.status === 'reauthorization_required' && status !== 'reauthorization_required')) return row;
  return tx.machineEnrollment.update({ where: { id: row.id }, data: {
    status, reason, sourceVersion: { increment: 1 },
  } });
}
/** This checks MACHINE authority. It never revalidates or changes a human refresh family. */
export async function machineAdmission(row: MachineEnrollment, auth: MachineAuthorization,
  credentialExpiresAt: Date, tx: MachineDb) {
  const now = await machineClock(tx);
  let reason: MachineReasonCode | undefined;
  let status = 'revoked';
  let sourceDeadline = Infinity;
  if (row.status === 'allowed') {
    const user = await tx.user.findUnique({ where: { id: row.subject },
      select: { lifecycleStatus: true, accountExpiresAt: true, tokenVersion: true, twoFaEnabled: true } });
    const domain = await tx.clientDomain.findUnique({ where: { domain: row.clientDomain }, select: { status: true, twoFaPolicy: true } });
    const organization = await tx.organisation.findUnique({ where: { id: row.orgId }, select: { twoFaPolicy: true } });
    const role = await tx.domainRole.findUnique({ where: { domain_userId: { domain: row.clientDomain, userId: row.subject } } });
    const product = await resolveProductTeamPolicy({ domain: row.clientDomain }, { prisma: tx, now: () => now });
    const team = await tx.team.findFirst({ where: { id: row.teamId, orgId: row.orgId,
      AND: [activeTeamAuthorityWhere(row.subject)] }, select: { id: true } });
    const policy = await tx.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: { clientDomain: row.clientDomain, orgId: row.orgId } } });
    if (!user) reason = 'account_unavailable';
    else if (user.tokenVersion !== auth.credentialEpoch) reason = 'security_reset';
    else if (!isActiveUser(user, now)) reason = 'account_unavailable';
    else if (domain?.status !== 'active' || product.scope !== 'all_active_memberships' || product.product !== 'nessie') reason = 'product_disabled';
    else if (!role || !team) { reason = 'access_removed'; status = 'access_removed'; }
    else if ((policy?.generation ?? 0) !== auth.policyGeneration) {
      reason = 'sso_policy_changed'; status = 'reauthorization_required';
    } else if (!auth.personalFactorCompleted && (user.twoFaEnabled || domain.twoFaPolicy === 'REQUIRED' || organization?.twoFaPolicy === 'REQUIRED')) {
      reason = 'authentication_policy_changed'; status = 'reauthorization_required';
    } else if (auth.expiresAt <= now) { reason = 'authorization_expired'; status = 'reauthorization_required'; }
    else if (row.lastActiveAt.getTime() + MACHINE_CREDENTIAL_MS <= now.getTime()) { reason = 'inactive'; status = 'reauthorization_required'; }
    else if (credentialExpiresAt <= now) { reason = 'credential_expired'; status = 'reauthorization_required'; }
    if (!reason) {
      try {
        if (auth.provenance === 'independent') await assertIndependentSourceStillAdmitted({ userId: row.subject,
          methods: auth.methods, personalFactorCompleted: auth.personalFactorCompleted }, tx);
        else {
          const connection = auth.connectionId ? await tx.orgSsoConnection.findUnique({ where: { id: auth.connectionId } }) : null;
          const identity = auth.externalIdentityId ? await tx.externalIdentity.findUnique({ where: { id: auth.externalIdentityId } }) : null;
          if (auth.provenance !== 'sso' || !connection || connection.status !== 'active' ||
            connection.clientDomain !== row.clientDomain || connection.orgId !== row.orgId ||
            connection.revision !== auth.connectionRevision || connection.generation !== auth.connectionGeneration ||
            !identity || identity.userId !== row.subject || identity.connectionId !== connection.id || identity.status !== 'ACTIVE') {
            reason = 'sso_policy_changed'; status = 'reauthorization_required';
          } else {
            await assertEnterpriseProvisioningActive(connection.id, identity.id, row.subject, tx);
            if (identity.domainClaimId) {
              const claim = await tx.organisationEmailDomain.findUnique({ where: { id: identity.domainClaimId }, select: { lastVerifiedAt: true } });
              sourceDeadline = claim?.lastVerifiedAt ? claim.lastVerifiedAt.getTime() + 86_400_000 : now.getTime();
              if (sourceDeadline <= now.getTime()) { reason = 'sso_policy_changed'; status = 'reauthorization_required'; }
            }
          }
        }
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
        reason = auth.provenance === 'independent' ? 'authentication_policy_changed' : 'sso_policy_changed'; status = 'reauthorization_required';
      }
    }
    if (!reason) {
      try {
        // Reuse canonical account admission. Backend egress is not a native device IP.
        await assertNotBannedAtLogin({ userId: row.subject, domain: row.clientDomain, ip: null }, { prisma: tx });
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
        reason = 'access_removed'; status = 'access_removed';
      }
    }
    if (reason) row = await stopMachine(row, status, reason, tx);
    const deadline = Math.min(now.getTime() + MACHINE_RECHECK_MS, auth.expiresAt.getTime(),
      credentialExpiresAt.getTime(), row.lastActiveAt.getTime() + MACHINE_CREDENTIAL_MS,
      user?.accountExpiresAt?.getTime() ?? Infinity, sourceDeadline);
    return machineDecision(row, auth, now, row.status === 'allowed' ? new Date(deadline) : now);
  }
  return machineDecision(row, auth, now, now);
}
function machineDecision(row: MachineEnrollment, auth: MachineAuthorization, now: Date, deadline: Date) {
  return { version: 1 as const, capability: 'machine_enrollment_v1' as const,
    decision: row.status, reason: row.reason, original_grant_id: row.id, authorization_id: auth.id,
    credential_generation: row.credentialGeneration, source_version: row.sourceVersion.toString(),
    client_domain: row.clientDomain, binding: machineBinding(row), key_thumbprint: auth.keyThumbprint,
    issued_at: now.toISOString(), recheck_by: deadline.toISOString(), authorization_expires_at: auth.expiresAt.toISOString() };
}
