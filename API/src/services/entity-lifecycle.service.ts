import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

export type LifecyclePrisma = Pick<PrismaClient, 'user' | 'organisation' | 'team'>;

export function isActiveLifecycle(status: string | undefined): boolean {
  return status === 'ACTIVE';
}

export function requireLiveIdentity<T extends { email: string | null; userKey: string | null; lifecycleStatus?: string }>(
  user: T | null,
): T & { email: string; userKey: string } {
  if (!user || !user.email || !user.userKey || !isActiveLifecycle(user.lifecycleStatus)) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
  return user as T & { email: string; userKey: string };
}

export function requireLiveEmail<T extends { email: string | null; lifecycleStatus?: string }>(user: T | null): T & { email: string } {
  if (!user || !user.email || !isActiveLifecycle(user.lifecycleStatus)) {
    throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  }
  return user as T & { email: string };
}

export function historicalIdentity(user: { id: string; lifecycleStatus: string; name: string | null }) {
  return { id: user.id, deleted: user.lifecycleStatus === 'DELETED',
    name: user.lifecycleStatus === 'DELETED' ? 'Deleted user' : user.name };
}

/** A lifecycle suspension is independent of membership status and has no superuser bypass. */
export async function assertEntityAccess(
  params: { userId?: string; orgId?: string | null; teamId?: string | null },
  prisma: LifecyclePrisma,
): Promise<void> {
  if (params.userId) {
    const user = await prisma.user.findUnique({ where: { id: params.userId }, select: { lifecycleStatus: true } });
    if (!user || !isActiveLifecycle(user.lifecycleStatus)) deny();
  }
  let orgId = params.orgId;
  if (params.teamId) {
    const team = await prisma.team.findUnique({ where: { id: params.teamId }, select: { lifecycleStatus: true, orgId: true } });
    if (!team || !isActiveLifecycle(team.lifecycleStatus) || (orgId && orgId !== team.orgId)) deny();
    orgId = team.orgId;
  }
  if (orgId) {
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { lifecycleStatus: true } });
    if (!org || !isActiveLifecycle(org.lifecycleStatus)) deny();
  }
}

function deny(): never { throw new AppError('FORBIDDEN', 403, 'ACCESS_DENIED'); }

export function requireIdentityEmail(email: string | null): string {
  if (!email) throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
  return email;
}
