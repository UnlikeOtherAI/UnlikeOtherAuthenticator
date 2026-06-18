import type { BanType, PrismaClient } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

type BanPrisma = Pick<PrismaClient, 'user' | 'ban'>;

type BanDeps = {
  prisma?: BanPrisma;
};

type BanRule = { type: BanType; value: string };

type Principal = {
  email: string;
  userId: string | null;
  ip: string | null;
};

const MAX_PATTERN_LENGTH = 320;

function resolvePrisma(injected?: BanPrisma): BanPrisma | null {
  if (injected) return injected;
  return getEnv().DATABASE_URL ? (getAdminPrisma() as BanPrisma) : null;
}

/**
 * Translate a shell-style glob (`*` = any run, `?` = single char) into an anchored,
 * case-insensitive matcher. We deliberately do NOT accept raw regular expressions from
 * admins so a ban pattern can never become a ReDoS vector.
 */
function globMatches(pattern: string, value: string): boolean {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_PATTERN_LENGTH) return false;
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return regex.test(value);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

/** Exact IP match, or IPv4 CIDR containment when the ban value is written as `a.b.c.d/n`. */
function ipMatches(banValue: string, ip: string): boolean {
  const ban = banValue.trim().toLowerCase();
  const candidate = ip.trim().toLowerCase();
  if (!ban) return false;
  if (!ban.includes('/')) return ban === candidate;

  const [network, bitsRaw] = ban.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const net = ipv4ToInt(network);
  const target = ipv4ToInt(candidate);
  if (net === null || target === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (net & mask) === (target & mask);
}

function matchesRule(rule: BanRule, principal: Principal): boolean {
  switch (rule.type) {
    case 'EMAIL':
      return rule.value.trim().toLowerCase() === principal.email;
    case 'PATTERN':
      return globMatches(rule.value, principal.email);
    case 'USER':
      return principal.userId !== null && rule.value === principal.userId;
    case 'IP':
      return principal.ip !== null && ipMatches(rule.value, principal.ip);
    default:
      return false;
  }
}

/**
 * Enforce the admin-managed ban list for a successfully authenticated user.
 *
 * Bans apply at three scopes — the client domain, any organisation the user belongs to,
 * and any team the user belongs to (all scoped to the login domain) — and always override
 * any allow-list. A SUPERUSER on the login domain bypasses bans, matching the allow-list
 * semantics in {@link assertEmailDomainAllowedForLogin}.
 *
 * Reads run on the BYPASSRLS admin client because login has no tenant context yet. Throws a
 * generic `ACCESS_DENIED` (no enumeration) when a ban matches.
 */
export async function assertNotBannedAtLogin(
  params: { userId: string; domain: string; ip?: string | null },
  deps?: BanDeps,
): Promise<void> {
  const prisma = resolvePrisma(deps?.prisma);
  if (!prisma) return;

  const loginDomain = normalizeDomain(params.domain);

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: {
      email: true,
      domainRoles: { where: { domain: loginDomain }, select: { role: true } },
      orgMembers: { where: { org: { domain: loginDomain } }, select: { orgId: true } },
      teamMembers: {
        where: { team: { org: { domain: loginDomain } } },
        select: { teamId: true },
      },
    },
  });
  if (!user) return;

  // A SUPERUSER on the login domain bypasses every ban, like the allow-list.
  if (user.domainRoles.some((role) => role.role === 'SUPERUSER')) return;

  const orgIds = user.orgMembers.map((member) => member.orgId);
  const teamIds = user.teamMembers.map((member) => member.teamId);

  const bans = await prisma.ban.findMany({
    where: {
      OR: [
        { domain: loginDomain, orgId: null, teamId: null },
        ...(orgIds.length ? [{ orgId: { in: orgIds } }] : []),
        ...(teamIds.length ? [{ teamId: { in: teamIds } }] : []),
      ],
    },
    select: { type: true, value: true },
  });
  if (bans.length === 0) return;

  const principal: Principal = {
    email: user.email.trim().toLowerCase(),
    userId: params.userId,
    ip: params.ip ?? null,
  };

  if (bans.some((ban) => matchesRule(ban, principal))) {
    throw new AppError('FORBIDDEN', 403, 'ACCESS_DENIED');
  }
}

/**
 * Whether a would-be registrant is banned at the client-domain scope. A brand-new user has
 * no org/team membership yet, so only domain-scope EMAIL / PATTERN / IP bans can apply.
 * Returns a boolean so the caller can fail closed without leaking which check tripped.
 */
export async function isPrincipalBannedForRegistration(
  params: { domain: string; email: string; ip?: string | null },
  deps?: BanDeps,
): Promise<boolean> {
  const prisma = resolvePrisma(deps?.prisma);
  if (!prisma) return false;

  const domain = normalizeDomain(params.domain);

  const bans = await prisma.ban.findMany({
    where: {
      domain,
      orgId: null,
      teamId: null,
      type: { in: ['EMAIL', 'PATTERN', 'IP'] },
    },
    select: { type: true, value: true },
  });
  if (bans.length === 0) return false;

  const principal: Principal = {
    email: params.email.trim().toLowerCase(),
    userId: null,
    ip: params.ip ?? null,
  };

  return bans.some((ban) => matchesRule(ban, principal));
}
