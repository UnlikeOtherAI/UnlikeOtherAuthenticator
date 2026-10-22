import { describe, expect, it } from 'vitest';
import { resolveTeamPeople } from '../../src/services/team.service.roster.js';
import { makeConfig, makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

const org = { id: 'org-1', domain: 'acme.example.com', name: 'Acme', slug: 'acme',
  ownerId: 'u-owner', createdAt: now, updatedAt: now };
const row = (userId: string) => ({ id: `tm-${userId}`, teamId: 'team-1', userId,
  teamRole: 'member', status: 'ACTIVE', createdAt: now, updatedAt: now,
  user: { id: userId, lifecycleStatus: 'ACTIVE', name: 'Current name', email: `${userId}@example.com` } });
const input = () => ({ orgId: org.id, teamId: 'team-1', domain: org.domain,
  actorUserId: 'u-member', config: makeConfig(), subjects: ['u-person'] });
const setup = () => {
  const prisma = makePrismaMock();
  prisma.organisation.findFirst.mockResolvedValue(org);
  prisma.orgMember.findFirst.mockResolvedValue({ id: 'om', orgId: org.id, userId: 'u-member', role: 'member' });
  prisma.orgMember.findMany.mockResolvedValue([{ userId: 'u-person', role: 'member', status: 'ACTIVE' }]);
  prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
  prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'member' });
  prisma.teamMember.findMany.mockResolvedValue([row('u-person')]);
  return prisma;
};
describe('exact team person resolution', () => {
  useTeamServiceTestEnv();
  it('reads only requested exact-team subjects and withholds another member email', async () => {
    const prisma = setup();
    const result = await resolveTeamPeople(input(), { prisma });
    expect(prisma.teamMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { teamId: 'team-1', userId: { in: ['u-person'] } },
    }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ subject: 'u-person', orgRole: 'member', identity: { displayName: 'Current name' } });
    expect(result[0].identity.email).toBeUndefined();
  });
  it('allows the reader to see their own email', async () => {
    const prisma = setup();
    prisma.teamMember.findMany.mockResolvedValue([row('u-member')]);
    const result = await resolveTeamPeople({ ...input(), subjects: ['u-member'] }, { prisma });
    expect(result[0].identity.email).toBe('u-member@example.com');
  });
  it('refuses an org member outside the selected team before reading requested profiles', async () => {
    const prisma = setup();
    prisma.teamMember.findFirst.mockResolvedValue(null);
    await expect(resolveTeamPeople(input(), { prisma })).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
  });
  it('caps requested subjects and omits missing records without a directory query', async () => {
    const prisma = setup();
    await expect(resolveTeamPeople({ ...input(), subjects: Array.from({ length: 101 }, (_, i) => `u-${i}`) }, { prisma }))
      .rejects.toThrow();
    prisma.teamMember.findMany.mockResolvedValue([]);
    expect(await resolveTeamPeople(input(), { prisma })).toEqual([]);
  });
});
