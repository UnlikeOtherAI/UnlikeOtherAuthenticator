import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AutomaticMembershipOperationStatus, MembershipStatus, Prisma, type PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { lockTeamMembershipRows } from './team-scope.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { AppError } from '../utils/errors.js';

type AutomaticMembershipPrisma = Pick<PrismaClient,
  'billingServiceAccess' | 'team' | 'orgMember' | 'teamMember' | 'authIdentity' | 'user' |
  'automaticMembershipProvisionFence' | 'automaticMembershipOperation' |
  'automaticMembershipSubjectSnapshot' | '$transaction' | '$queryRaw'>;
type Transaction = Parameters<Parameters<AutomaticMembershipPrisma['$transaction']>[0]>[0];
const administratorRoles = new Set(['owner', 'admin']);

async function assertScope(prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, orgId: string): Promise<void> {
  const access = await prisma.billingServiceAccess.findFirst({
    where: { serviceId: credential.service.id, orgId, active: true, revokedAt: null }, select: { id: true },
  });
  if (!access) throw new AppError('FORBIDDEN', 403, 'AUTOMATIC_MEMBERSHIP_SERVICE_ACCESS_REQUIRED');
}

function exactEmailDomain(email: string, domain: string): boolean {
  const at = email.lastIndexOf('@');
  return at > 0 && email.slice(at + 1).toLowerCase() === domain;
}

async function lockRule(tx: Transaction, serviceId: string, ruleId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${serviceId}:${ruleId}`}, 0))`);
}

function cursorDigest(snapshotId: string, cursor: string): string {
  return createHmac('sha256', getEnv().SHARED_SECRET).update(`${snapshotId}.${cursor}`, 'utf8').digest('hex');
}

function newCursor(): string {
  return randomBytes(32).toString('base64url');
}

export async function listAutomaticMembershipTeams(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, orgId: string,
): Promise<{ team_id: string; name: string }[]> {
  await assertScope(prisma, credential, orgId);
  const rows = await prisma.team.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  return rows.map((row) => ({ team_id: row.id, name: row.name }));
}

/** New callers name one exact scope. The old teamIds form remains readable during deployment. */
export async function isAutomaticMembershipAdministrator(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey,
  input: { orgId: string; subject: string; teamIds?: string[]; scope?: 'organisation' | 'team'; teamId?: string },
): Promise<boolean> {
  await assertScope(prisma, credential, input.orgId);
  if (input.scope === 'organisation') {
    const member = await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId: input.orgId, userId: input.subject } }, select: { role: true, status: true } });
    return member?.status === MembershipStatus.ACTIVE && administratorRoles.has(member.role);
  }
  if (input.scope === 'team') {
    if (!input.teamId) return false;
    const team = await prisma.team.findFirst({
      where: { id: input.teamId, orgId: input.orgId, members: { some: { userId: input.subject, status: MembershipStatus.ACTIVE, teamRole: { in: ['owner', 'admin'] } } } }, select: { id: true },
    });
    return Boolean(team);
  }
  const org = await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId: input.orgId, userId: input.subject } }, select: { role: true, status: true } });
  if (org?.status === MembershipStatus.ACTIVE && administratorRoles.has(org.role)) return true;
  const ids = [...new Set(input.teamIds ?? [])];
  if (ids.length === 0) return false;
  const teams = await prisma.team.findMany({ where: { id: { in: ids }, orgId: input.orgId, members: { some: { userId: input.subject, status: MembershipStatus.ACTIVE, teamRole: { in: ['owner', 'admin'] } } } }, select: { id: true } });
  return teams.length === ids.length;
}

export async function attestAutomaticMembershipDomain(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey,
  input: { orgId: string; subject: string; domain: string },
): Promise<{ subject: string; domain: string; asserted_at: string; expires_at: string } | null> {
  await assertScope(prisma, credential, input.orgId);
  const identities = await prisma.authIdentity.findMany({ where: { userId: input.subject, verifiedAt: { not: null } }, select: { email: true } });
  if (!identities.some((identity) => exactEmailDomain(identity.email, input.domain))) return null;
  const now = new Date();
  return { subject: input.subject, domain: input.domain, asserted_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString() };
}

export async function listAutomaticMembershipSubjects(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey,
  input: { orgId: string; domain: string; cursor?: string; snapshotId?: string; limit: number },
): Promise<{ snapshot_id: string; subjects: string[]; cursor: string | null }> {
  await assertScope(prisma, credential, input.orgId);
  const now = new Date();
  const snapshot = input.snapshotId
    ? await prisma.automaticMembershipSubjectSnapshot.findFirst({ where: { id: input.snapshotId, serviceId: credential.service.id, orgId: input.orgId, domain: input.domain, expiresAt: { gt: now } } })
    : await prisma.automaticMembershipSubjectSnapshot.create({ data: { id: randomUUID(), serviceId: credential.service.id, orgId: input.orgId, domain: input.domain, cutoffAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000) } });
  if (!snapshot) throw new AppError('CONFLICT', 409, 'AUTOMATIC_MEMBERSHIP_SNAPSHOT_EXPIRED');
  if (input.snapshotId && (!input.cursor || !snapshot.cursorHash || !snapshot.cursorUserId || cursorDigest(snapshot.id, input.cursor) !== snapshot.cursorHash)) {
    throw new AppError('CONFLICT', 409, 'AUTOMATIC_MEMBERSHIP_SNAPSHOT_RESTART_REQUIRED');
  }
  const after = input.snapshotId ? snapshot.cursorUserId ?? '' : '';
  // Exact-domain filtering happens before DISTINCT ON, so a nonmatching identity cannot hide one user.
  const rows = await prisma.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT DISTINCT ON (ai."user_id") ai."user_id" AS "userId"
    FROM "auth_identities" ai
    WHERE ai."verified_at" IS NOT NULL AND ai."created_at" <= ${snapshot.cutoffAt}
      AND lower(split_part(ai."email"::text, '@', 2)) = lower(${input.domain})
      AND ai."user_id" > ${after}
    ORDER BY ai."user_id" ASC, ai."created_at" ASC
    LIMIT ${input.limit + 1}
  `);
  const page = rows.slice(0, input.limit);
  if (rows.length <= input.limit) return { snapshot_id: snapshot.id, subjects: page.map((row) => row.userId), cursor: null };
  const cursor = newCursor();
  await prisma.automaticMembershipSubjectSnapshot.update({ where: { id: snapshot.id }, data: { cursorHash: cursorDigest(snapshot.id, cursor), cursorUserId: page.at(-1)?.userId ?? after } });
  return { snapshot_id: snapshot.id, subjects: page.map((row) => row.userId), cursor };
}

export async function setAutomaticMembershipFence(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey,
  input: { orgId: string; ruleId: string; generation: number; lifecycleRevision: number; fenceToken: string; active: boolean },
): Promise<void> {
  await assertScope(prisma, credential, input.orgId);
  await prisma.$transaction(async (tx) => {
    await lockRule(tx, credential.service.id, input.ruleId);
    const current = await tx.automaticMembershipProvisionFence.findUnique({ where: { serviceId_ruleId: { serviceId: credential.service.id, ruleId: input.ruleId } } });
    const stale = current && (input.generation < current.generation || input.lifecycleRevision < current.lifecycleRevision || (input.generation === current.generation && input.lifecycleRevision === current.lifecycleRevision && (input.fenceToken !== current.fenceToken || input.active !== current.active)));
    if (stale) throw new AppError('CONFLICT', 409, 'AUTOMATIC_MEMBERSHIP_STALE_FENCE');
    await tx.automaticMembershipProvisionFence.upsert({
      where: { serviceId_ruleId: { serviceId: credential.service.id, ruleId: input.ruleId } },
      create: { id: createHash('sha256').update(`${credential.service.id}:${input.ruleId}`).digest('base64url'), serviceId: credential.service.id, orgId: input.orgId, ruleId: input.ruleId, generation: input.generation, lifecycleRevision: input.lifecycleRevision, fenceToken: input.fenceToken, active: input.active },
      update: { orgId: input.orgId, generation: input.generation, lifecycleRevision: input.lifecycleRevision, fenceToken: input.fenceToken, active: input.active },
    });
  });
}

export async function grantAutomaticMembership(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey,
  input: { orgId: string; teamId: string; subject: string; domain: string; idempotencyKey: string; ruleId: string; generation: number; lifecycleRevision: number; fenceToken: string },
): Promise<{ operation_id: string; status: 'completed' | 'already_member' | 'skipped_inactive' }> {
  await assertScope(prisma, credential, input.orgId);
  const operationId = createHash('sha256').update(`${credential.id}:${input.idempotencyKey}`).digest('base64url');
  return prisma.$transaction(async (tx) => {
    await lockRule(tx, credential.service.id, input.ruleId);
    const fence = await tx.automaticMembershipProvisionFence.findUnique({ where: { serviceId_ruleId: { serviceId: credential.service.id, ruleId: input.ruleId } } });
    if (!fence || !fence.active || fence.orgId !== input.orgId || fence.generation !== input.generation || fence.lifecycleRevision !== input.lifecycleRevision || fence.fenceToken !== input.fenceToken) throw new AppError('CONFLICT', 409, 'AUTOMATIC_MEMBERSHIP_STALE_FENCE');
    const replay = await tx.automaticMembershipOperation.findUnique({ where: { serviceId_idempotencyKey: { serviceId: credential.service.id, idempotencyKey: input.idempotencyKey } } });
    if (replay) return { operation_id: replay.id, status: replay.status === AutomaticMembershipOperationStatus.already_member ? 'already_member' : replay.status === AutomaticMembershipOperationStatus.skipped_inactive ? 'skipped_inactive' : 'completed' };
    const [team, user, verified] = await Promise.all([
      tx.team.findFirst({ where: { id: input.teamId, orgId: input.orgId }, select: { id: true } }),
      tx.user.findUnique({ where: { id: input.subject }, select: { id: true } }),
      tx.authIdentity.findMany({ where: { userId: input.subject, verifiedAt: { not: null } }, select: { email: true } }),
    ]);
    if (!team || !user) throw new AppError('NOT_FOUND', 404, 'AUTOMATIC_MEMBERSHIP_TARGET_NOT_FOUND');
    if (!verified.some((identity) => exactEmailDomain(identity.email, input.domain))) throw new AppError('FORBIDDEN', 403, 'AUTOMATIC_MEMBERSHIP_DOMAIN_NOT_VERIFIED');
    await lockTeamMembershipRows({ userId: input.subject, orgId: input.orgId, teamId: input.teamId }, { prisma: tx });
    const [orgMember, teamMember] = await Promise.all([
      tx.orgMember.findUnique({ where: { orgId_userId: { orgId: input.orgId, userId: input.subject } }, select: { status: true } }),
      tx.teamMember.findUnique({ where: { teamId_userId: { teamId: input.teamId, userId: input.subject } }, select: { status: true } }),
    ]);
    const inactive = (orgMember !== null && orgMember.status !== MembershipStatus.ACTIVE) || (teamMember !== null && teamMember.status !== MembershipStatus.ACTIVE);
    if (!inactive) {
      // A concurrent manual/SCIM insert wins without being rewritten by this rule.
      if (!orgMember) await tx.orgMember.createMany({ data: { orgId: input.orgId, userId: input.subject, role: 'member', status: MembershipStatus.ACTIVE }, skipDuplicates: true });
      if (!teamMember) await tx.teamMember.createMany({ data: { teamId: input.teamId, userId: input.subject, teamRole: 'member', status: MembershipStatus.ACTIVE }, skipDuplicates: true });
    }
    const status = inactive ? AutomaticMembershipOperationStatus.skipped_inactive : orgMember && teamMember ? AutomaticMembershipOperationStatus.already_member : AutomaticMembershipOperationStatus.completed;
    await tx.automaticMembershipOperation.create({ data: { id: operationId, serviceId: credential.service.id, orgId: input.orgId, teamId: input.teamId, ruleId: input.ruleId, generation: input.generation, fenceToken: input.fenceToken, subjectId: input.subject, idempotencyKey: input.idempotencyKey, status } });
    return { operation_id: operationId, status: status === AutomaticMembershipOperationStatus.already_member ? 'already_member' : status === AutomaticMembershipOperationStatus.skipped_inactive ? 'skipped_inactive' : 'completed' };
  });
}

export async function getAutomaticMembershipOperation(prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, operationId: string): Promise<{ operation_id: string; status: string }> {
  const operation = await prisma.automaticMembershipOperation.findFirst({ where: { id: operationId, serviceId: credential.service.id }, select: { id: true, status: true } });
  if (!operation) throw new AppError('NOT_FOUND', 404, 'AUTOMATIC_MEMBERSHIP_OPERATION_NOT_FOUND');
  return { operation_id: operation.id, status: operation.status };
}
