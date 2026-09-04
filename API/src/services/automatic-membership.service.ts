import { createHash, randomUUID } from 'node:crypto';
import { AutomaticMembershipOperationStatus, MembershipStatus, type PrismaClient } from '@prisma/client';

import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { AppError } from '../utils/errors.js';

type AutomaticMembershipPrisma = Pick<PrismaClient, 'billingServiceAccess' | 'team' | 'orgMember' | 'teamMember' | 'authIdentity' | 'user' | 'automaticMembershipProvisionFence' | 'automaticMembershipOperation' | 'automaticMembershipSubjectSnapshot' | '$transaction'>;
const memberRoles = new Set(['owner', 'admin']);

async function assertScope(prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, orgId: string): Promise<void> {
  const access = await prisma.billingServiceAccess.findFirst({
    where: { serviceId: credential.service.id, orgId, active: true, revokedAt: null }, select: { id: true },
  });
  if (!access) throw new AppError('FORBIDDEN', 403, 'AUTOMATIC_MEMBERSHIP_SERVICE_ACCESS_REQUIRED');
}

export async function listAutomaticMembershipTeams(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, orgId: string,
): Promise<{ team_id: string; name: string }[]> {
  await assertScope(prisma, credential, orgId);
  return prisma.team.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    .then((rows) => rows.map((row) => ({ team_id: row.id, name: row.name })));
}

export async function isAutomaticMembershipAdministrator(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, input: { orgId: string; subject: string; teamIds: string[] },
): Promise<boolean> {
  await assertScope(prisma, credential, input.orgId);
  const org = await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId: input.orgId, userId: input.subject } }, select: { role: true, status: true } });
  if (org?.status === MembershipStatus.ACTIVE && memberRoles.has(org.role)) return true;
  if (input.teamIds.length === 0) return false;
  const teams = await prisma.team.findMany({ where: { id: { in: input.teamIds }, orgId: input.orgId, members: { some: { userId: input.subject, status: MembershipStatus.ACTIVE, teamRole: { in: ['owner', 'admin'] } } } }, select: { id: true } });
  return teams.length === new Set(input.teamIds).size;
}

const exactEmailDomain = (email: string, domain: string): boolean => email.toLowerCase().split('@')[1] === domain;

export async function attestAutomaticMembershipDomain(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, input: { subject: string; domain: string },
): Promise<{ subject: string; domain: string; asserted_at: string; expires_at: string } | null> {
  // The product key proves the relying party; this verifies UOA's own current
  // identity record. An exchanged email string is never accepted as proof.
  const identities = await prisma.authIdentity.findMany({ where: { userId: input.subject, verifiedAt: { not: null } }, select: { email: true } });
  if (!identities.some((identity) => exactEmailDomain(identity.email, input.domain))) return null;
  const now = new Date();
  return { subject: input.subject, domain: input.domain, asserted_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString() };
}

export async function listAutomaticMembershipSubjects(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, input: { orgId: string; domain: string; cursor?: string; snapshotId?: string; limit: number },
): Promise<{ snapshot_id: string; subjects: string[]; cursor: string | null }> {
  await assertScope(prisma, credential, input.orgId);
  const now = new Date();
  const snapshot = input.snapshotId
    ? await prisma.automaticMembershipSubjectSnapshot.findFirst({ where: { id: input.snapshotId, serviceId: credential.service.id, orgId: input.orgId, domain: input.domain, expiresAt: { gt: now } } })
    : await prisma.automaticMembershipSubjectSnapshot.create({ data: { id: randomUUID(), serviceId: credential.service.id, orgId: input.orgId, domain: input.domain, cutoffAt: now, expiresAt: new Date(now.getTime() + 15 * 60 * 1000) } });
  if (!snapshot) throw new AppError('CONFLICT', 409, 'AUTOMATIC_MEMBERSHIP_SNAPSHOT_EXPIRED');
  // The snapshot cutoff makes rows immutable for this run. DISTINCT user ids
  // prevents multiple verified providers for one person becoming duplicate work.
  const rows = await prisma.authIdentity.findMany({ where: { verifiedAt: { not: null }, createdAt: { lte: snapshot.cutoffAt }, ...(input.cursor ? { userId: { gt: input.cursor } } : {}) }, select: { userId: true, email: true }, orderBy: { userId: 'asc' }, distinct: ['userId'], take: input.limit + 1 });
  const eligible = rows.filter((row) => exactEmailDomain(row.email, input.domain));
  const page = eligible.slice(0, input.limit);
  return { snapshot_id: snapshot.id, subjects: page.map((row) => row.userId), cursor: rows.length > input.limit ? rows[input.limit - 1]?.userId ?? null : null };
}

export async function setAutomaticMembershipFence(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, input: { orgId: string; ruleId: string; generation: number; fenceToken: string; active: boolean },
): Promise<void> {
  await assertScope(prisma, credential, input.orgId);
  const current = await prisma.automaticMembershipProvisionFence.findUnique({ where: { serviceId_ruleId: { serviceId: credential.service.id, ruleId: input.ruleId } }, select: { generation: true } });
  if (current && input.generation < current.generation) throw new AppError('CONFLICT', 409, 'AUTOMATIC_MEMBERSHIP_STALE_FENCE');
  await prisma.automaticMembershipProvisionFence.upsert({
    where: { serviceId_ruleId: { serviceId: credential.service.id, ruleId: input.ruleId } },
    create: { id: createHash('sha256').update(`${credential.service.id}:${input.ruleId}`).digest('base64url'), serviceId: credential.service.id, orgId: input.orgId, ruleId: input.ruleId, generation: input.generation, fenceToken: input.fenceToken, active: input.active },
    update: { orgId: input.orgId, generation: input.generation, fenceToken: input.fenceToken, active: input.active },
  });
}

export async function grantAutomaticMembership(
  prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, input: { orgId: string; teamId: string; subject: string; domain: string; idempotencyKey: string; ruleId: string; generation: number; fenceToken: string },
): Promise<{ operation_id: string; status: 'completed' | 'already_member' }> {
  await assertScope(prisma, credential, input.orgId);
  const operation_id = createHash('sha256').update(`${credential.id}:${input.idempotencyKey}`).digest('base64url');
  return prisma.$transaction(async (tx) => {
    const fence = await tx.automaticMembershipProvisionFence.findUnique({ where: { serviceId_ruleId: { serviceId: credential.service.id, ruleId: input.ruleId } } });
    if (!fence || !fence.active || fence.orgId !== input.orgId || fence.generation !== input.generation || fence.fenceToken !== input.fenceToken) throw new AppError('CONFLICT', 409, 'AUTOMATIC_MEMBERSHIP_STALE_FENCE');
    const verified = await tx.authIdentity.findMany({ where: { userId: input.subject, verifiedAt: { not: null } }, select: { email: true } });
    if (!verified.some((identity) => exactEmailDomain(identity.email, input.domain))) throw new AppError('FORBIDDEN', 403, 'AUTOMATIC_MEMBERSHIP_DOMAIN_NOT_VERIFIED');
    const replay = await tx.automaticMembershipOperation.findUnique({ where: { serviceId_idempotencyKey: { serviceId: credential.service.id, idempotencyKey: input.idempotencyKey } } });
    if (replay) return { operation_id: replay.id, status: replay.status === AutomaticMembershipOperationStatus.already_member ? 'already_member' : 'completed' };
    const team = await tx.team.findFirst({ where: { id: input.teamId, orgId: input.orgId }, select: { id: true } });
    const user = await tx.user.findUnique({ where: { id: input.subject }, select: { id: true } });
    if (!team || !user) throw new AppError('NOT_FOUND', 404, 'AUTOMATIC_MEMBERSHIP_TARGET_NOT_FOUND');
    const [existingOrg, existingTeam] = await Promise.all([
      tx.orgMember.findUnique({ where: { orgId_userId: { orgId: input.orgId, userId: input.subject } }, select: { status: true } }),
      tx.teamMember.findUnique({ where: { teamId_userId: { teamId: input.teamId, userId: input.subject } }, select: { status: true } }),
    ]);
    await tx.orgMember.upsert({ where: { orgId_userId: { orgId: input.orgId, userId: input.subject } }, create: { orgId: input.orgId, userId: input.subject, role: 'member', status: MembershipStatus.ACTIVE }, update: { status: MembershipStatus.ACTIVE } });
    await tx.teamMember.upsert({ where: { teamId_userId: { teamId: input.teamId, userId: input.subject } }, create: { teamId: input.teamId, userId: input.subject, teamRole: 'member', status: MembershipStatus.ACTIVE }, update: { status: MembershipStatus.ACTIVE } });
    const status = existingOrg?.status === MembershipStatus.ACTIVE && existingTeam?.status === MembershipStatus.ACTIVE ? AutomaticMembershipOperationStatus.already_member : AutomaticMembershipOperationStatus.completed;
    await tx.automaticMembershipOperation.create({ data: { id: operation_id, serviceId: credential.service.id, orgId: input.orgId, teamId: input.teamId, ruleId: input.ruleId, generation: input.generation, fenceToken: input.fenceToken, subjectId: input.subject, idempotencyKey: input.idempotencyKey, status } });
    return { operation_id, status: status === AutomaticMembershipOperationStatus.already_member ? 'already_member' : 'completed' };
  });
}

export async function getAutomaticMembershipOperation(prisma: AutomaticMembershipPrisma, credential: VerifiedBillingAppKey, operationId: string): Promise<{ operation_id: string; status: string }> {
  const operation = await prisma.automaticMembershipOperation.findFirst({ where: { id: operationId, serviceId: credential.service.id }, select: { id: true, status: true } });
  if (!operation) throw new AppError('NOT_FOUND', 404, 'AUTOMATIC_MEMBERSHIP_OPERATION_NOT_FOUND');
  return { operation_id: operation.id, status: operation.status };
}
