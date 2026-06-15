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

type ScopeRestriction = {
  domains: string[];
  emails: string[];
};

function lowerList(values: readonly string[]): string[] {
  return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

/**
 * Enforces allowed-login email-domain/email restrictions for a successfully authenticated user.
 *
 * Restrictions can be configured at three levels — the client domain, any organisation the user
 * belongs to, and any team the user belongs to (all scoped to the login's client domain). If a
 * level has a non-empty `allowedEmailDomains` or `allowedEmails` list, the user's email domain or
 * exact lower-cased email must appear in that level. A SUPERUSER on the login domain bypasses every
 * restriction.
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
        select: { org: { select: { allowedEmailDomains: true, allowedEmails: true } } },
      },
      teamMembers: {
        where: { team: { org: { domain: loginDomain } } },
        select: { team: { select: { allowedEmailDomains: true, allowedEmails: true } } },
      },
    },
  });

  // Defensive: a finalized login always has a real user. Nothing to enforce if it vanished.
  if (!user) return;

  // SUPERUSER on the login domain bypasses every restriction.
  if (user.domainRoles.some((role) => role.role === 'SUPERUSER')) return;

  const clientDomain = await prisma.clientDomain.findUnique({
    where: { domain: loginDomain },
    select: { allowedEmailDomains: true, allowedEmails: true },
  });

  const restrictionLists: ScopeRestriction[] = [
    {
      domains: clientDomain?.allowedEmailDomains ?? [],
      emails: clientDomain?.allowedEmails ?? [],
    },
    ...user.orgMembers.map((member) => ({
      domains: member.org.allowedEmailDomains,
      emails: member.org.allowedEmails,
    })),
    ...user.teamMembers.map((member) => ({
      domains: member.team.allowedEmailDomains,
      emails: member.team.allowedEmails,
    })),
  ]
    .map((scope) => ({ domains: lowerList(scope.domains), emails: lowerList(scope.emails) }))
    .filter((scope) => scope.domains.length > 0 || scope.emails.length > 0);

  if (restrictionLists.length === 0) return;

  const email = user.email.trim().toLowerCase();
  const emailDomain = extractEmailDomain(user.email);
  const allowed = restrictionLists.every(
    (scope) =>
      (emailDomain !== null && scope.domains.includes(emailDomain)) || scope.emails.includes(email),
  );

  if (!allowed) {
    throw new AppError('FORBIDDEN', 403, 'EMAIL_DOMAIN_NOT_ALLOWED');
  }
}

/**
 * Admin-managed registration allowlist for a client domain.
 *
 * A client domain's `allowedEmails` (exact) and `allowedEmailDomains` (email-domain) lists are
 * managed by a superuser in the admin panel. When a config has `allow_registration: false`, a new
 * user whose email — or whose email domain — is explicitly listed here is still permitted to
 * register: the admin allowlist is an explicit grant that overrides the config's registration gate.
 * An empty allowlist grants nothing (returns false), so it never widens access on its own.
 *
 * Client-domain level only: a brand-new user has no organisation/team membership yet, so only the
 * domain-wide lists can apply at registration time. Reads run on the BYPASSRLS admin client.
 */
export async function isEmailAdminAllowedForRegistration(
  params: { domain: string; email: string },
  deps?: { prisma?: Pick<PrismaClient, 'clientDomain'> },
): Promise<boolean> {
  const prisma =
    deps?.prisma ?? (getEnv().DATABASE_URL ? (getAdminPrisma() as Pick<PrismaClient, 'clientDomain'>) : null);
  if (!prisma) return false;

  const clientDomain = await prisma.clientDomain.findUnique({
    where: { domain: normalizeDomain(params.domain) },
    select: { allowedEmailDomains: true, allowedEmails: true },
  });
  if (!clientDomain) return false;

  const emails = lowerList(clientDomain.allowedEmails);
  const domains = lowerList(clientDomain.allowedEmailDomains);
  if (emails.length === 0 && domains.length === 0) return false;

  const email = params.email.trim().toLowerCase();
  const emailDomain = extractEmailDomain(params.email);
  return emails.includes(email) || (emailDomain !== null && domains.includes(emailDomain));
}
