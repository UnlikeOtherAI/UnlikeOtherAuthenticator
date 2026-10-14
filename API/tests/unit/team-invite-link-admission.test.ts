import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../../src/services/config.service.js';
import { redeemTeamInviteLink } from '../../src/services/team-invite-link.service.js';

const originalDatabase = process.env.DATABASE_URL;
beforeEach(() => { process.env.DATABASE_URL = 'postgresql://invite-admission.unit.invalid/db'; });
afterEach(() => { if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase; });

function fixture() {
  const now = new Date('2026-10-14T12:00:00Z');
  const config = { domain: 'other-product.example.com', org_features: {
    enabled: true, org_roles: ['owner', 'admin', 'member'], team_roles: ['owner', 'admin', 'member'],
    max_members_per_org: 2, max_members_per_team: 2, max_team_memberships_per_user: 2,
  } } as ClientConfig;
  const link = { id: 'link', orgId: 'org', teamId: 'team', roleToAssign: 'member',
    maxUses: 10, useCount: 0, revokedAt: null, expiresAt: new Date(now.getTime() + 1000) };
  const memberships = { org: { id: 'org-member', orgId: 'org', status: 'ACTIVE' } as { id: string; orgId: string; status: string } | null,
    team: { id: 'team-member', status: 'ACTIVE', teamRole: 'admin' } as { id: string; status: string; teamRole: string } | null };
  const raw = {
    $queryRaw: vi.fn(async () => []),
    teamInviteLink: { findUnique: vi.fn(async () => link), updateMany: vi.fn(async () => ({ count: 1 })) },
    team: { findFirst: vi.fn(async () => ({ id: 'team', orgId: 'org', joinPolicy: 'INVITE_ONLY', org: { domain: 'origin.example.com' } })) },
    orgMember: { findFirst: vi.fn(async () => memberships.org), count: vi.fn(async () => 0),
      create: vi.fn(async () => (memberships.org = { id: 'new-org-member', orgId: 'org', status: 'ACTIVE' })) },
    teamMember: { findFirst: vi.fn(async () => memberships.team), count: vi.fn(async () => 0),
      create: vi.fn(async () => (memberships.team = { id: 'new-team-member', status: 'ACTIVE', teamRole: link.roleToAssign })),
      update: vi.fn(async () => Object.assign(memberships.team!, { status: 'ACTIVE', teamRole: link.roleToAssign })) },
  };
  const redeem = (clock = () => now) => redeemTeamInviteLink({ token: 'synthetic', userId: 'person',
    domain: config.domain, config }, { prisma: raw as unknown as PrismaClient, now: clock, sharedSecret: 'synthetic-invite-admission-test-material' });
  return { now, config, link, memberships, raw, redeem };
}

describe('invite-link current admission policy', () => {
  it('keeps an already-active role and ignores new-seat limits for that exact membership', async () => {
    const f = fixture(); f.raw.teamMember.count.mockResolvedValue(2); f.raw.orgMember.count.mockResolvedValue(2);
    await expect(f.redeem()).resolves.toEqual({ orgId: 'org', teamId: 'team' });
    expect(f.memberships.team?.teamRole).toBe('admin');
    expect(f.raw.teamMember.update).not.toHaveBeenCalled();
    expect(f.raw.teamMember.count).not.toHaveBeenCalled();
    expect(f.raw.orgMember.count).not.toHaveBeenCalled();
  });

  it.each(['DEACTIVATED', 'REMOVED'])('does not reactivate a %s organisation membership', async status => {
    const f = fixture(); f.memberships.org!.status = status;
    await expect(f.redeem()).rejects.toMatchObject({ statusCode: 400 });
    expect(f.raw.orgMember.create).not.toHaveBeenCalled();
    expect(f.raw.teamMember.update).not.toHaveBeenCalled();
  });

  it('does not lift a team suspension', async () => {
    const f = fixture(); f.memberships.team!.status = 'DEACTIVATED';
    await expect(f.redeem()).rejects.toMatchObject({ statusCode: 400 });
    expect(f.raw.teamMember.update).not.toHaveBeenCalled();
  });

  it('reactivates removed team membership with the fresh link role', async () => {
    const f = fixture(); f.memberships.team!.status = 'REMOVED';
    await expect(f.redeem()).resolves.toEqual({ orgId: 'org', teamId: 'team' });
    expect(f.raw.teamMember.update).toHaveBeenCalledWith({ where: { id: 'team-member' },
      data: { status: 'ACTIVE', statusChangedAt: f.now, teamRole: 'member' } });
    expect(f.memberships.team?.teamRole).toBe('member');
  });

  it.each(['organisation', 'team', 'user'])('enforces the %s new-seat limit', async scope => {
    const f = fixture(); f.memberships.team = null;
    if (scope === 'organisation') { f.memberships.org = null; f.raw.orgMember.count.mockResolvedValue(2); }
    if (scope === 'team') f.raw.teamMember.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    if (scope === 'user') f.raw.teamMember.count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    await expect(f.redeem()).rejects.toMatchObject({ statusCode: 400 });
    expect(f.raw.teamMember.create).not.toHaveBeenCalled();
    if (scope === 'organisation') expect(f.raw.orgMember.create).not.toHaveBeenCalled();
  });

  it.each(['owner', 'unknown-role'])('refuses link role %s before consumption', async role => {
    const f = fixture(); f.link.roleToAssign = role;
    await expect(f.redeem()).rejects.toMatchObject({ statusCode: 400 });
    expect(f.raw.teamInviteLink.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks expiry after its lock boundary before consuming a link', async () => {
    const f = fixture(); let checks = 0;
    await expect(f.redeem(() => ++checks === 1 ? f.now : f.link.expiresAt)).rejects.toMatchObject({ statusCode: 400 });
    expect(f.raw.teamInviteLink.updateMany).not.toHaveBeenCalled();
  });

  it('pins exact current lifecycle/membership filters without substituting origin-domain admission', async () => {
    const f = fixture(); await f.redeem();
    expect(f.raw.orgMember.findFirst).toHaveBeenLastCalledWith({ where: {
      orgId: 'org', userId: 'person', status: 'ACTIVE', user: { lifecycleStatus: 'ACTIVE' }, org: { lifecycleStatus: 'ACTIVE' },
    }, select: { id: true } });
    expect(f.raw.teamMember.findFirst).toHaveBeenLastCalledWith({ where: {
      teamId: 'team', userId: 'person', status: 'ACTIVE', user: { lifecycleStatus: 'ACTIVE' },
      team: { orgId: 'org', lifecycleStatus: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE' } },
    }, select: { id: true } });
  });
});
