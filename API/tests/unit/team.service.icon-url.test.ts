import { describe, expect, it } from 'vitest';

import { updateTeam } from '../../src/services/team.service.js';
import { makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

// CLAUDE.md 500-line split: gap-fix A Task 3's `icon_url` write/validation on
// `PUT /org/organisations/:orgId/teams/:teamId`, split out of team.service.test.ts to keep that
// file under the 500-line cap.
describe('Team service: updateTeam icon_url', () => {
  useTeamServiceTestEnv();

  it('accepts an https icon_url and echoes it on the updated record', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1', slug: 'engineering' });
    prisma.team.update.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      slug: 'engineering',
      description: null,
      isDefault: false,
      iconUrl: 'https://cdn.example.com/team.png',
      createdAt: now,
      updatedAt: now,
    });

    const result = await updateTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        iconUrl: 'https://cdn.example.com/team.png',
      },
      { prisma },
    );

    expect(prisma.team.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ iconUrl: 'https://cdn.example.com/team.png' }),
      }),
    );
    expect(result.iconUrl).toBe('https://cdn.example.com/team.png');
  });

  it('clears a team icon_url when explicitly set to null', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1', slug: 'engineering' });
    prisma.team.update.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      slug: 'engineering',
      description: null,
      isDefault: false,
      iconUrl: null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await updateTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        iconUrl: null,
      },
      { prisma },
    );

    expect(prisma.team.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ iconUrl: null }) }),
    );
    expect(result.iconUrl).toBeNull();
  });

  it('rejects a junk (non-URL) icon_url with a generic error', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1', slug: 'engineering' });

    const promise = updateTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        iconUrl: 'not-a-url',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.team.update).not.toHaveBeenCalled();
  });
});
