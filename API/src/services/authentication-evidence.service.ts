import { assertMailboxCredentialAdmission } from './credential-admission.service.js';
import { randomBytes, createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { fingerprintClientConfig } from './client-config-fingerprint.service.js';
import type { ClientConfig } from './config.service.js';

type EvidenceDb = PrismaClient | Prisma.TransactionClient;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function deny(): never { throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_EVIDENCE_REQUIRED'); }

/** Only actual independently verified primary authentication callers may invoke this mint. */
export async function recordIndependentAuthentication(input: { userId: string; credentialEpoch: number;
  method: string; config: ClientConfig; configUrl: string; redirectUrl: string; codeChallenge?: string;
}, db: EvidenceDb = getAdminPrisma()): Promise<string> {
  if (input.method === 'sso' || input.method === 'sso_recovery') deny();
  // Corporate mailbox access cannot become independent proof for a managed identity.
  if (['email_code', 'email_registration', 'email_link', 'login_link', 'verify_email', 'verify_email_set_password']
    .includes(input.method)) await assertMailboxCredentialAdmission(input.userId, db);
  const now = new Date();
  const reference = randomBytes(32).toString('base64url');
  const row = await db.authenticationEvidence.create({ data: { referenceHash: digest(reference),
    userId: input.userId, credentialEpoch: input.credentialEpoch, clientDomain: input.config.domain,
    method: input.method, provenance: 'independent', authenticatedAt: now, observedAt: now,
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
  let ancestor = row; const seen = new Set([row.id]);
  while (ancestor.parentId) {
    if (seen.size >= 8 || seen.has(ancestor.parentId)) deny();
    const parent = await db.authenticationEvidence.findUnique({ where: { id: ancestor.parentId } });
    if (!parent || parent.revokedAt || !parent.consumedAt || parent.expiresAt < ancestor.expiresAt ||
      parent.userId !== row.userId || parent.credentialEpoch !== row.credentialEpoch ||
      parent.clientDomain !== row.clientDomain || parent.provenance !== row.provenance || parent.method !== row.method ||
      parent.connectionId !== row.connectionId || parent.externalIdentityId !== row.externalIdentityId ||
      parent.connectionRevision !== row.connectionRevision || parent.connectionGeneration !== row.connectionGeneration ||
      (row.provenance !== 'independent' && (parent.orgId !== row.orgId || parent.teamId !== row.teamId)) ||
      (ancestor.purpose === 'management' && (parent.purpose !== 'authorize' || row.provenance !== 'independent')) ||
      parent.authenticatedAt?.getTime() !== row.authenticatedAt?.getTime() || parent.observedAt.getTime() !== row.observedAt.getTime()) deny();
    seen.add(parent.id); ancestor = parent;
  }
  const user = await db.user.findUnique({ where: { id: row.userId }, select: { tokenVersion: true, lifecycleStatus: true } });
  if (!user || user.lifecycleStatus !== 'ACTIVE' || user.tokenVersion !== row.credentialEpoch) deny();
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
