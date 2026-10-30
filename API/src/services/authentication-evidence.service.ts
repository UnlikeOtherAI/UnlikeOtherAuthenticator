import { assertMailboxCredentialAdmission, assertIndependentSourceStillAdmitted } from './credential-admission.service.js';
import { assertEnterpriseProvisioningActive } from './enterprise-identity-status.service.js';
import { randomBytes, createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { isActiveUser } from './entity-lifecycle.service.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import type { ClientConfig } from './config.service.js';

export type VerifiedAuthenticationEvent = { kind: 'local_credential' } | { kind: 'provider'; authenticatedAt: Date | null };
type EvidenceDb = PrismaClient | Prisma.TransactionClient;

/** A signed chooser continuation does not expand an organisation IdP's authority. */
export async function assertIndependentChooserMutation(input: { authenticationEvidenceId?: string;
  userId: string; credentialEpoch: number; domain: string }, db: EvidenceDb): Promise<void> {
  if (!input.authenticationEvidenceId) return;
  const evidence = await requireAuthenticationEvidence({ id: input.authenticationEvidenceId,
    userId: input.userId, credentialEpoch: input.credentialEpoch, clientDomain: input.domain }, db);
  if (evidence.provenance !== 'independent') throw new AppError('FORBIDDEN', 403, 'SSO_TEAM_REAUTH_REQUIRED');
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function deny(): never { throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_EVIDENCE_REQUIRED'); }

/** Only actual independently verified primary authentication callers may invoke this mint. */
export async function recordIndependentAuthentication(input: { userId: string; credentialEpoch: number;
  method: string; verifiedEvent: VerifiedAuthenticationEvent; config: ClientConfig; configUrl: string; redirectUrl: string; codeChallenge?: string;
}, db: EvidenceDb = getAdminPrisma()): Promise<string> {
  if (['sso', 'sso_recovery', 'recovery'].includes(input.method)) deny();
  // Corporate mailbox access cannot become independent proof for a managed identity.
  if (['email_code', 'email_registration', 'email_link', 'login_link', 'verify_email', 'verify_email_set_password']
    .includes(input.method)) await assertMailboxCredentialAdmission(input.userId, db);
  const now = new Date();
  const authenticatedAt = input.verifiedEvent.kind === 'local_credential' ? now : input.verifiedEvent.authenticatedAt;
  if (authenticatedAt && (!Number.isFinite(authenticatedAt.getTime()) || authenticatedAt.getTime() > now.getTime() + 120000)) deny();
  const reference = randomBytes(32).toString('base64url');
  const row = await db.authenticationEvidence.create({ data: { referenceHash: digest(reference),
    userId: input.userId, credentialEpoch: input.credentialEpoch, clientDomain: input.config.domain,
    method: input.method, provenance: 'independent', amr: [input.method], authenticatedAt, observedAt: now,
    purpose: 'authorize', actionBinding: digest(JSON.stringify({ config: fingerprintClientConfig(input.config),
      configUrl: input.configUrl, redirectUrl: input.redirectUrl, codeChallenge: input.codeChallenge ?? null })),
    expiresAt: new Date(now.getTime() + 15 * 60000) } });
  // This ID travels only inside signed server artifacts, never as a standalone bearer capability.
  return row.id;
}

async function validateAuthenticationEvidence(input: { id?: string; userId: string; credentialEpoch: number;
  clientDomain: string; allowConsumed?: boolean }, db: EvidenceDb = getAdminPrisma()) {
  if (!input.id) deny();
  const row = await db.authenticationEvidence.findUnique({ where: { id: input.id } });
  if (!row || row.userId !== input.userId || row.credentialEpoch !== input.credentialEpoch ||
    row.clientDomain !== input.clientDomain || row.revokedAt || (!input.allowConsumed && row.consumedAt) ||
    row.expiresAt <= new Date()) deny();
  const latestAllowed = Date.now() + 120000;
  if (row.observedAt.getTime() > latestAllowed || (row.authenticatedAt?.getTime() ?? 0) > latestAllowed ||
    (row.mfaCompletedAt?.getTime() ?? 0) > latestAllowed) deny();
  let ancestor = row; const seen = new Set([row.id]);
  while (ancestor.parentId) {
    if (seen.size >= 8 || seen.has(ancestor.parentId)) deny();
    const parent = await db.authenticationEvidence.findUnique({ where: { id: ancestor.parentId } });
    if (!parent || parent.revokedAt || !parent.consumedAt || parent.expiresAt < ancestor.expiresAt ||
      parent.userId !== row.userId || parent.credentialEpoch !== row.credentialEpoch ||
      parent.clientDomain !== row.clientDomain || parent.provenance !== row.provenance || parent.method !== row.method ||
      parent.connectionId !== row.connectionId || parent.externalIdentityId !== row.externalIdentityId ||
      parent.connectionRevision !== row.connectionRevision || parent.connectionGeneration !== row.connectionGeneration ||
      parent.policyGeneration !== row.policyGeneration || parent.sessionDeadline?.getTime() !== row.sessionDeadline?.getTime() ||
      JSON.stringify(parent.amr) !== JSON.stringify(row.amr) || parent.acr !== row.acr ||
      (row.provenance !== 'independent' && (parent.orgId !== row.orgId || parent.teamId !== row.teamId)) ||
      (ancestor.purpose === 'management' && (parent.purpose !== 'authorize' || row.provenance !== 'independent')) ||
      parent.authenticatedAt?.getTime() !== row.authenticatedAt?.getTime() || parent.observedAt.getTime() !== row.observedAt.getTime()) deny();
    seen.add(parent.id); ancestor = parent;
  }
  if (row.provenance === 'independent') await assertIndependentSourceStillAdmitted({ userId: row.userId,
    methods: row.amr, personalFactorCompleted: Boolean(row.mfaCompletedAt) }, db);
  if (row.provenance !== 'independent') {
    if (!row.orgId || !row.connectionId || !row.externalIdentityId) deny();
    const [connection, identity, policy, member] = await Promise.all([
      db.orgSsoConnection.findUnique({ where: { id: row.connectionId } }),
      db.externalIdentity.findUnique({ where: { id: row.externalIdentityId } }),
      db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: { clientDomain: row.clientDomain, orgId: row.orgId } } }),
      db.orgMember.findFirst({ where: { orgId: row.orgId, userId: row.userId, status: 'ACTIVE' } }),
    ]);
    if (row.provenance !== 'sso' || connection?.status !== 'active' || connection.clientDomain !== row.clientDomain ||
      connection.orgId !== row.orgId || connection.revision !== row.connectionRevision || connection.generation !== row.connectionGeneration ||
      identity?.status !== 'ACTIVE' || identity.userId !== row.userId || identity.connectionId !== row.connectionId ||
      identity.clientDomain !== row.clientDomain || identity.orgId !== row.orgId || !policy?.arrangementEnabled ||
      policy.generation !== row.policyGeneration || !member || !row.sessionDeadline || row.sessionDeadline <= new Date()) deny();
    await assertEnterpriseProvisioningActive(row.connectionId, row.externalIdentityId, row.userId, db);
    if (row.teamId && !await db.teamMember.findFirst({ where: { userId: row.userId, teamId: row.teamId, status: 'ACTIVE',
      team: { orgId: row.orgId, lifecycleStatus: 'ACTIVE' } } })) deny();
  }
  const user = await db.user.findUnique({ where: { id: row.userId }, select: { tokenVersion: true, lifecycleStatus: true, accountExpiresAt: true } });
  if (!user || !isActiveUser(user) || user.tokenVersion !== row.credentialEpoch) deny();
  return row;
}

/** Final-factor result comes from the shared verifier, never a browser boolean. */
export async function finalizeAuthenticationEvidence(input: { id?: string; userId: string; credentialEpoch: number;
  config: ClientConfig; configUrl: string; redirectUrl: string; codeChallenge?: string; twoFaCompleted: boolean;
}, db: EvidenceDb) {
  const minimum = await db.enterpriseProductReadiness.findUnique({ where: { clientDomain: input.config.domain } });
  if (!input.id && !minimum?.minimumAssuranceVersion) return;
  const row = await requireAuthenticationEvidence({ id: input.id, userId: input.userId,
    credentialEpoch: input.credentialEpoch, clientDomain: input.config.domain }, db);
  const expected = digest(JSON.stringify({ config: fingerprintClientConfig(input.config), configUrl: input.configUrl,
    redirectUrl: input.redirectUrl, codeChallenge: input.codeChallenge ?? null }));
  if (row.purpose !== 'authorize' || row.actionBinding !== expected) deny();
  if (input.twoFaCompleted && !row.mfaCompletedAt) await db.authenticationEvidence.update({ where: { id: row.id },
    data: { mfaCompletedAt: new Date() } });
}

export async function requireAuthenticationEvidence(input: Parameters<typeof validateAuthenticationEvidence>[0],
  db: EvidenceDb = getAdminPrisma()) {
  try { return await validateAuthenticationEvidence(input, db); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'AUTHENTICATION_EVIDENCE_UNAVAILABLE');
  }
}
