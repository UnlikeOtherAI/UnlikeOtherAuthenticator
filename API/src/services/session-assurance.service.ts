import { assertIndependentSourceStillAdmitted } from './credential-admission.service.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient, SessionAssurance } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { runInTransaction } from '../db/tenant-context.js';
import { assertEnterpriseProvisioningActive } from './enterprise-identity-status.service.js';
import { isActiveUser } from './entity-lifecycle.service.js';

export type AssuranceDb = Pick<PrismaClient,
  'sessionAssurance' | 'refreshToken' | 'user' | 'orgSsoPolicy' | 'orgSsoConnection' |
  'externalIdentity' | 'orgMember' | 'teamMember' | 'enterpriseProductReadiness' | 'scimResourceLink' | 'organisationEmailDomain'>;
export type AssuranceBinding = {
  userId: string; clientDomain: string; credentialEpoch: number;
  orgId?: string | null; teamId?: string | null;
};
export type AccountRequirement = 'global_account_control' | 'enterprise_org_access' | 'sso_recovery';
const context = new AsyncLocalStorage<SessionAssurance>();
export const hashAssuranceReference = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function withSessionAssurance<T>(assurance: SessionAssurance, run: () => Promise<T>): Promise<T> {
  return context.run(assurance, run);
}

function reject(): never { throw new AppError('UNAUTHORIZED', 401, 'INVALID_SESSION_ASSURANCE'); }

/** Resolve ancestors and live authorities. Neither a JWT claim nor an epoch is proof of method. */
export async function validateSessionAssurance(
  binding: AssuranceBinding & { reference?: string; id?: string; requirement?: AccountRequirement },
  db: AssuranceDb = getAdminPrisma(),
  now = new Date(),
): Promise<SessionAssurance> {
  try { return await validateSessionAssuranceInside(binding, db, now); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'ASSURANCE_AUTHORITY_UNAVAILABLE');
  }
}
async function validateSessionAssuranceInside(
  binding: AssuranceBinding & { reference?: string; id?: string; requirement?: AccountRequirement },
  db: AssuranceDb, now: Date,
): Promise<SessionAssurance> {
  if ((!binding.reference && !binding.id) || (binding.reference && binding.id)) reject();
  let row = await db.sessionAssurance.findUnique({ where: binding.reference
    ? { referenceHash: hashAssuranceReference(binding.reference) } : { id: binding.id ?? reject() } });
  if (!row || row.userId !== binding.userId || row.clientDomain !== binding.clientDomain ||
    row.credentialEpoch !== binding.credentialEpoch || row.orgId !== (binding.orgId ?? null) ||
    row.teamId !== (binding.teamId ?? null)) reject();
  const leaf = row;
  const visited = new Set<string>();
  for (let depth = 0; row; depth++) {
    if (depth >= 8 || visited.has(row.id) || row.revokedAt || row.expiresAt <= now ||
      row.userId !== leaf.userId || row.credentialEpoch !== leaf.credentialEpoch ||
      row.expiresAt < leaf.expiresAt || row.method !== leaf.method ||
      row.clientDomain !== leaf.clientDomain || row.orgId !== leaf.orgId || row.teamId !== leaf.teamId ||
      row.connectionId !== leaf.connectionId || row.externalIdentityId !== leaf.externalIdentityId ||
      row.authenticatedAt?.getTime() !== leaf.authenticatedAt?.getTime() || row.observedAt.getTime() !== leaf.observedAt.getTime() ||
      row.mfaSource !== leaf.mfaSource || row.acr !== leaf.acr || JSON.stringify(row.amr) !== JSON.stringify(leaf.amr)) reject();
    if (row.observedAt.getTime() > now.getTime() + 120000 ||
      (row.authenticatedAt && row.authenticatedAt.getTime() > now.getTime() + 120000)) reject();
    visited.add(row.id);
    const [user, family] = await Promise.all([
      db.user.findUnique({ where: { id: row.userId }, select: { lifecycleStatus: true, accountExpiresAt: true, tokenVersion: true } }),
      db.refreshToken.findFirst({ where: { familyId: row.familyId, userId: row.userId,
        domain: row.clientDomain, orgId: row.orgId, teamId: row.teamId,
        revokedAt: null, expiresAt: { gt: now } }, select: { id: true, expiresAt: true } }),
    ]);
    if (!user || !isActiveUser(user) || user.tokenVersion !== row.credentialEpoch ||
      !family || family.expiresAt < row.expiresAt) reject();
    if (row.orgId) {
      const member = await db.orgMember.findUnique({ where: { orgId_userId: { orgId: row.orgId, userId: row.userId } },
        select: { status: true, org: { select: { lifecycleStatus: true } } } });
      if (member?.status !== 'ACTIVE' || member.org.lifecycleStatus !== 'ACTIVE') reject();
      const policy = await db.orgSsoPolicy.findUnique({ where: {
        clientDomain_orgId: { clientDomain: row.clientDomain, orgId: row.orgId } } });
      if ((policy?.generation ?? 0) !== row.policyGeneration) reject();
    }
    if (row.teamId) {
      const team = await db.teamMember.findUnique({ where: { teamId_userId: { teamId: row.teamId, userId: row.userId } },
        select: { status: true, team: { select: { orgId: true, lifecycleStatus: true } } } });
      if (team?.status !== 'ACTIVE' || team.team.orgId !== row.orgId || team.team.lifecycleStatus !== 'ACTIVE') reject();
    }
    if (row.method === 'sso') {
      if (!row.connectionId || !row.externalIdentityId) reject();
      const [connection, identity] = await Promise.all([
        db.orgSsoConnection.findUnique({ where: { id: row.connectionId } }),
        db.externalIdentity.findUnique({ where: { id: row.externalIdentityId } }),
      ]);
      if (!connection || connection.status !== 'active' || connection.clientDomain !== row.clientDomain ||
        connection.orgId !== row.orgId || connection.revision !== row.connectionRevision ||
        connection.generation !== row.connectionGeneration || identity?.status !== 'ACTIVE' ||
        identity.connectionId !== connection.id || identity.userId !== row.userId) reject();
      await assertEnterpriseProvisioningActive(connection.id, identity.id, row.userId, db);
    }
    if (!row.parentId) break;
    row = await db.sessionAssurance.findUnique({ where: { id: row.parentId } });
    if (!row) reject();
  }
  if (leaf.method === 'independent') await assertIndependentSourceStillAdmitted({ userId: leaf.userId,
    methods: leaf.amr, personalFactorCompleted: leaf.mfaSource === 'uoa_totp' }, db);
  if (binding.requirement === 'global_account_control' && leaf.method !== 'independent') reject();
  if (binding.requirement === 'sso_recovery' && leaf.method !== 'recovery') reject();
  return leaf;
}

/** Called only after final proof, under the same transaction that created the source family. */
export async function issueSessionAssurance(
  data: Omit<Prisma.SessionAssuranceUncheckedCreateInput, 'id' | 'referenceHash'>,
  db: AssuranceDb,
): Promise<{ assurance: SessionAssurance; reference: string }> {
  if (typeof (db as Partial<PrismaClient>).$transaction === 'function') {
    return runInTransaction(db as PrismaClient, (tx) => issueSessionAssurance(data, tx));
  }
  if (data.method !== 'independent' && data.method !== 'sso' && data.method !== 'recovery') reject();
  if (data.parentId) {
    const parent = await db.sessionAssurance.findUnique({ where: { id: data.parentId } });
    if (!parent || parent.method !== data.method || parent.userId !== data.userId ||
      parent.credentialEpoch !== data.credentialEpoch || parent.clientDomain !== data.clientDomain ||
      parent.orgId !== (data.orgId ?? null) || parent.teamId !== (data.teamId ?? null) ||
      parent.connectionId !== (data.connectionId ?? null) || parent.externalIdentityId !== (data.externalIdentityId ?? null) ||
      parent.expiresAt < new Date(data.expiresAt) || parent.observedAt.getTime() !== new Date(data.observedAt).getTime() ||
      parent.authenticatedAt?.getTime() !== (data.authenticatedAt ? new Date(data.authenticatedAt).getTime() : undefined) ||
      parent.mfaSource !== data.mfaSource || parent.acr !== (data.acr ?? null) || JSON.stringify(parent.amr) !== JSON.stringify(data.amr)) reject();
  }
  const reference = randomBytes(32).toString('base64url');
  const assurance = await db.sessionAssurance.create({ data: {
    ...data, referenceHash: hashAssuranceReference(reference),
  } });
  await validateSessionAssurance({ id: assurance.id, userId: assurance.userId,
    clientDomain: assurance.clientDomain, credentialEpoch: assurance.credentialEpoch,
    orgId: assurance.orgId, teamId: assurance.teamId }, db);
  return { assurance, reference };
}

/** Server-owned version prevents products from opting back into missing-proof legacy sessions. */
export async function requireProductAssurance(
  binding: AssuranceBinding & { reference?: string; id?: string }, db: AssuranceDb = getAdminPrisma(),
): Promise<SessionAssurance | null> {
  let product;
  try { product = await db.enterpriseProductReadiness.findUnique({ where: { clientDomain: binding.clientDomain } }); }
  catch { throw new AppError('SERVICE_UNAVAILABLE', 503, 'ASSURANCE_AUTHORITY_UNAVAILABLE'); }
  if (!binding.reference && !binding.id && !product?.minimumAssuranceVersion) return null;
  return validateSessionAssurance(binding, db);
}

export function currentSessionAssurance(): SessionAssurance | undefined { return context.getStore(); }
