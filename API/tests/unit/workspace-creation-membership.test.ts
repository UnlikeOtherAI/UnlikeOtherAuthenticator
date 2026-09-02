import { describe, expect, it } from 'vitest';

import { createTeam } from '../../src/services/team.service.js';
import { resolveWorkspaceCreatorTeamRole } from '../../src/services/role-grants.js';
import { makeConfig, makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

/**
 * Creating a workspace has to leave the creator able to ENTER it.
 *
 * Every entry check — including `/billing/v1/service-access/confirm`, which
 * re-reads live rows rather than trusting session claims — requires an ACTIVE
 * `TeamMember`. `createTeam` wrote only the team row, so a product driving
 * workspace creation from its own UI created a team its author could not open.
 */

const ORG_ROW = {
  id: 'org-1',
  domain: 'acme.example.com',
  name: 'Acme',
  slug: 'acme',
  ownerId: 'u-owner',
  createdAt: now,
  updatedAt: now,
};

const seedOwner = (prisma: ReturnType<typeof makePrismaMock>, actorUserId: string) => {
  prisma.organisation.findFirst.mockResolvedValue(ORG_ROW);
  prisma.orgMember.findFirst.mockResolvedValue({
    id: 'om-actor',
    orgId: 'org-1',
    userId: actorUserId,
    role: 'owner',
    createdAt: now,
    updatedAt: now,
  });
  prisma.team.count.mockResolvedValue(0);
  prisma.team.findFirst.mockResolvedValue(null);
  prisma.team.create.mockResolvedValue({
    id: 'team-new',
    orgId: 'org-1',
    groupId: null,
    name: 'Design',
    slug: 'design',
    description: null,
    isDefault: false,
    joinPolicy: 'INVITE_ONLY',
    iconUrl: null,
    createdAt: now,
    updatedAt: now,
  });
};

describe('creating a workspace leaves its creator able to enter it', () => {
  useTeamServiceTestEnv();

  it('adds the creator as the new team owner when asked', async () => {
    const prisma = makePrismaMock();
    seedOwner(prisma, 'u-owner');

    await createTeam(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Design',
        joinCreator: true,
        config: makeConfig(),
      },
      { prisma },
    );

    expect(prisma.teamMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId_userId: { teamId: 'team-new', userId: 'u-owner' } },
        create: expect.objectContaining({
          teamId: 'team-new',
          userId: 'u-owner',
          teamRole: 'owner',
        }),
      }),
    );
  });

  it('is an upsert, so the hosted chooser adding the same membership cannot 409', async () => {
    const prisma = makePrismaMock();
    seedOwner(prisma, 'u-owner');

    await createTeam(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Design',
        joinCreator: true,
        config: makeConfig(),
      },
      { prisma },
    );

    // An existing membership must be left exactly as it is, never rewritten:
    // re-running creation should not silently promote or demote a role
    // somebody has since changed.
    const call = prisma.teamMember.upsert.mock.calls[0]?.[0];
    expect(call?.update).toEqual({});
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it('leaves the roster alone by default, so backend provisioning is unchanged', async () => {
    const prisma = makePrismaMock();
    seedOwner(prisma, 'u-owner');

    await createTeam(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Design',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
  });
});

describe('the creator role respects the domain vocabulary', () => {
  it('is owner under the default vocabulary', () => {
    expect(resolveWorkspaceCreatorTeamRole(makeConfig())).toBe('owner');
  });

  it('falls back to the most privileged configured role when owner is absent', () => {
    // A domain that authored `team_roles: ["lead","member"]` must not have
    // `owner` written into its rows: it would be unmentionable by role_grants
    // (so the creator would hold nothing) and rejected by normalizeTeamRole on
    // every later write.
    const config = makeConfig({ team_roles: ['lead', 'member'] });
    expect(resolveWorkspaceCreatorTeamRole(config)).toBe('lead');
  });
});
