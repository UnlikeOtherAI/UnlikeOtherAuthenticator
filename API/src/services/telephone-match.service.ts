import type { PrismaClient } from '@prisma/client';

/** Current same-team routing candidates; callers must never treat this as authentication. */
export async function resolveTelephoneMatch(tx: PrismaClient, scope: { organisation_id: string; team_id: string }, number: string) {
  const phones = await tx.userTelephone.findMany({ where: { OR: [{ number }, { pendingNumber: number }],
    user: { lifecycleStatus: 'ACTIVE', orgMembers: { some: { orgId: scope.organisation_id, status: 'ACTIVE',
      org: { lifecycleStatus: 'ACTIVE' } } }, teamMembers: { some: { teamId: scope.team_id, status: 'ACTIVE',
      team: { orgId: scope.organisation_id, lifecycleStatus: 'ACTIVE' } } } } },
    select: { userId: true, number: true, verifiedAt: true, user: { select: { tokenVersion: true } } }, take: 2 });
  const phone = phones[0];
  if (phones.length > 1) return { state: 'ambiguous' as const };
  if (!phone) return { state: 'no_match' as const };
  if (phone.number !== number || !phone.verifiedAt) return { state: 'pending' as const };
  return { state: 'verified' as const, subject: phone.userId, verifiedAt: phone.verifiedAt,
    tokenVersion: phone.user.tokenVersion };
}
