import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import {
  assertNotBannedAtLogin,
  isPrincipalBannedForRegistration,
} from '../../src/services/ban-policy.service.js';

type BanRule = { type: 'EMAIL' | 'PATTERN' | 'IP' | 'USER'; value: string };

function loginPrisma(opts: {
  email: string;
  roles?: { role: string }[];
  orgIds?: string[];
  teamIds?: string[];
  bans: BanRule[];
}): Pick<PrismaClient, 'user' | 'ban'> {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        email: opts.email,
        domainRoles: opts.roles ?? [],
        orgMembers: (opts.orgIds ?? []).map((orgId) => ({ orgId })),
        teamMembers: (opts.teamIds ?? []).map((teamId) => ({ teamId })),
      }),
    },
    ban: { findMany: vi.fn().mockResolvedValue(opts.bans) },
  } as unknown as Pick<PrismaClient, 'user' | 'ban'>;
}

function regPrisma(bans: BanRule[]): Pick<PrismaClient, 'user' | 'ban'> {
  return {
    user: { findUnique: vi.fn() },
    ban: { findMany: vi.fn().mockResolvedValue(bans) },
  } as unknown as Pick<PrismaClient, 'user' | 'ban'>;
}

describe('assertNotBannedAtLogin', () => {
  const base = { userId: 'u_1', domain: 'client.example.com' };

  it('blocks an exact email ban', async () => {
    const prisma = loginPrisma({ email: 'bad@example.com', bans: [{ type: 'EMAIL', value: 'bad@example.com' }] });
    await expect(assertNotBannedAtLogin(base, { prisma })).rejects.toMatchObject({
      statusCode: 403,
      message: 'ACCESS_DENIED',
    });
  });

  it('blocks a glob pattern ban (case-insensitive)', async () => {
    const prisma = loginPrisma({ email: 'Mallory@Evil.com', bans: [{ type: 'PATTERN', value: '*@evil.com' }] });
    await expect(assertNotBannedAtLogin(base, { prisma })).rejects.toMatchObject({ message: 'ACCESS_DENIED' });
  });

  it('blocks a userId ban', async () => {
    const prisma = loginPrisma({ email: 'a@b.com', bans: [{ type: 'USER', value: 'u_1' }] });
    await expect(assertNotBannedAtLogin(base, { prisma })).rejects.toMatchObject({ message: 'ACCESS_DENIED' });
  });

  it('blocks an IPv4 CIDR ban and allows IPs outside it', async () => {
    const prisma = loginPrisma({ email: 'a@b.com', bans: [{ type: 'IP', value: '10.0.0.0/8' }] });
    await expect(assertNotBannedAtLogin({ ...base, ip: '10.1.2.3' }, { prisma })).rejects.toMatchObject({
      message: 'ACCESS_DENIED',
    });

    const prisma2 = loginPrisma({ email: 'a@b.com', bans: [{ type: 'IP', value: '10.0.0.0/8' }] });
    await expect(assertNotBannedAtLogin({ ...base, ip: '192.168.0.1' }, { prisma: prisma2 })).resolves.toBeUndefined();
  });

  it('a SUPERUSER on the login domain bypasses every ban', async () => {
    const prisma = loginPrisma({
      email: 'bad@example.com',
      roles: [{ role: 'SUPERUSER' }],
      bans: [{ type: 'EMAIL', value: 'bad@example.com' }],
    });
    await expect(assertNotBannedAtLogin(base, { prisma })).resolves.toBeUndefined();
    expect(prisma.ban.findMany).not.toHaveBeenCalled();
  });

  it('passes when no ban matches', async () => {
    const prisma = loginPrisma({ email: 'good@example.com', bans: [{ type: 'EMAIL', value: 'bad@example.com' }] });
    await expect(assertNotBannedAtLogin(base, { prisma })).resolves.toBeUndefined();
  });

  it('does not block on an IP ban when the route supplied no IP', async () => {
    const prisma = loginPrisma({ email: 'a@b.com', bans: [{ type: 'IP', value: '10.0.0.0/8' }] });
    await expect(assertNotBannedAtLogin(base, { prisma })).resolves.toBeUndefined();
  });
});

describe('isPrincipalBannedForRegistration', () => {
  const base = { domain: 'client.example.com', email: 'new@evil.com' };

  it('returns true for a matching domain-scope pattern ban', async () => {
    const prisma = regPrisma([{ type: 'PATTERN', value: '*@evil.com' }]);
    await expect(isPrincipalBannedForRegistration(base, { prisma })).resolves.toBe(true);
  });

  it('returns true for a matching IP ban', async () => {
    const prisma = regPrisma([{ type: 'IP', value: '203.0.113.7' }]);
    await expect(
      isPrincipalBannedForRegistration({ ...base, ip: '203.0.113.7' }, { prisma }),
    ).resolves.toBe(true);
  });

  it('returns false when nothing matches', async () => {
    const prisma = regPrisma([{ type: 'EMAIL', value: 'someone@else.com' }]);
    await expect(isPrincipalBannedForRegistration(base, { prisma })).resolves.toBe(false);
  });
});
