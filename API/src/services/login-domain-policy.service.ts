import type { PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { extractEmailDomain } from '../utils/email-domain.js';
import { AppError } from '../utils/errors.js';

type PolicyPrisma = Pick<PrismaClient, 'user' | 'clientDomain'>;

type PolicyDeps = {
  prisma?: PolicyPrisma;
};

/**
 * Enforces allowed-login-email-domain restrictions for a successfully authenticated user.
 *
 * Restrictions can be configured at three levels — the client domain, any organisation the user
 * belongs to, and any team the user belongs to (all scoped to the login's client domain). If a
 * level has a non-empty `allowedEmailDomains` list, the user's email domain must appear in it.
 * A SUPERUSER on the login domain bypasses every restriction.
 *
 * Reads run on the BYPASSRLS admin client because the relevant org/team rows are tenant-scoped and
 * login has no tenant context yet (mirrors domain-hash auth and config-verifier).
 */
export async function assertEmailDomainAllowedForLogin(
  params: { userId: string; domain: string },
  deps?: PolicyDeps,
): Promise<void> {
  // No database means there are no stored restrictions to enforce. An injected prisma (tests)
  // is always honoured; otherwise we use the BYPASSRLS admin client when a database is configured.
  const prisma = deps?.prisma ?? (getEnv().DATABASE_URL ? (getAdminPrisma() as PolicyPrisma) : null);
  if (!prisma) return;

  const loginDomain = normalizeDomain(params.domain);

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: {
      email: true,
      domainRoles: {
        where: { domain: loginDomain },
        select: { role: true },
      },
      orgMembers: {
        where: { org: { domain: loginDomain } },
        select: { org: { select: { allowedEmailDomains: true } } },
      },
      teamMembers: {
        where: { team: { org: { domain: loginDomain } } },
        select: { team: { select: { allowedEmailDomains: true } } },
      },
    },
  });

  // Defensive: a finalized login always has a real user. Nothing to enforce if it vanished.
  if (!user) return;

  // SUPERUSER on the login domain bypasses every restriction.
  if (user.domainRoles.some((role) => role.role === 'SUPERUSER')) return;

  const clientDomain = await prisma.clientDomain.findUnique({
    where: { domain: loginDomain },
    select: { allowedEmailDomains: true },
  });

  const restrictionLists: string[][] = [
    clientDomain?.allowedEmailDomains ?? [],
    ...user.orgMembers.map((member) => member.org.allowedEmailDomains),
    ...user.teamMembers.map((member) => member.team.allowedEmailDomains),
  ].filter((list) => list.length > 0);

  if (restrictionLists.length === 0) return;

  const emailDomain = extractEmailDomain(user.email);
  const allowed =
    emailDomain !== null && restrictionLists.every((list) => list.includes(emailDomain));

  if (!allowed) {
    throw new AppError('FORBIDDEN', 403, 'EMAIL_DOMAIN_NOT_ALLOWED');
  }
}
