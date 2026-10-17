import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient, SessionAssurance } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

export type AssuranceDb = Pick<PrismaClient,
  'sessionAssurance' | 'refreshToken' | 'user' | 'orgSsoPolicy' | 'orgSsoConnection' |
  'externalIdentity' | 'orgMember' | 'teamMember' | 'enterpriseProductReadiness'>;
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
      row.expiresAt < leaf.expiresAt) reject();
    visited.add(row.id);
    const [user, family] = await Promise.all([
      db.user.findUnique({ where: { id: row.userId }, select: { lifecycleStatus: true, tokenVersion: true } }),
      db.refreshToken.findFirst({ where: { familyId: row.familyId, userId: row.userId,
        domain: row.clientDomain, revokedAt: null, expiresAt: { gt: now } }, select: { id: true } }),
    ]);
    if (!user || user.lifecycleStatus !== 'ACTIVE' || user.tokenVersion !== row.credentialEpoch || !family) reject();
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
    }
    if (!row.parentId) break;
    row = await db.sessionAssurance.findUnique({ where: { id: row.parentId } });
    if (!row) reject();
    // Enterprise/recovery authority must never be laundered through an independent child.
    if (row.method !== 'independent' && leaf.method === 'independent') reject();
  }
  if (binding.requirement === 'global_account_control' && leaf.method !== 'independent') reject();
  if (binding.requirement === 'sso_recovery' && leaf.method !== 'recovery') reject();
  return leaf;
}

/** Called only after final proof, under the same transaction that created the source family. */
export async function issueSessionAssurance(
  data: Omit<Prisma.SessionAssuranceUncheckedCreateInput, 'id' | 'referenceHash'>,
  db: AssuranceDb,
): Promise<{ assurance: SessionAssurance; reference: string }> {
  if (data.method !== 'independent' && data.method !== 'sso' && data.method !== 'recovery') reject();
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
  const product = await db.enterpriseProductReadiness.findUnique({ where: { clientDomain: binding.clientDomain } });
  if (!binding.reference && !binding.id && !product?.minimumAssuranceVersion) return null;
  return validateSessionAssurance(binding, db);
}

export function currentSessionAssurance(): SessionAssurance | undefined { return context.getStore(); }
