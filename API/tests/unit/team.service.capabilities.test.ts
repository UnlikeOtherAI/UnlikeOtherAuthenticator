import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { ClientConfig } from '../../src/services/config.service.js';
import { changeTeamMemberRole, createTeam } from '../../src/services/team.service.js';
import { makeConfig, makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

/**
 * Wave 1 of `Docs/plans/2026-08-16-configurable-roles-and-capabilities.md`, at the service gates.
 *
 * Two things are under test. First the ONE deliberate behaviour change: `requireTeamManager` used
 * to read the org membership and nothing else, so a team owner/admin could not administer their own
 * team's roster. It now resolves `members.manage` over the union of org- and team-scope grants, so
 * they can — the owner's constraint #1. Second, that a domain's own vocabulary and grant table
 * actually decide these gates, rather than a hard-coded `owner|admin`.
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

/**
 * Seed the lookups a roster mutation makes: the org, the actor's ORG membership at `orgRole`, the
 * actor's TEAM membership at `teamRole` (null = not a member of it), the target team, and the
 * target member row.
 */
function seedRoster(
  prisma: PrismaClient,
  params: { actorUserId: string; orgRole: string | null; teamRole: string | null },
): void {
  prisma.organisation.findFirst.mockResolvedValue(ORG_ROW);
  prisma.orgMember.findFirst.mockImplementation((args: { where: { userId: string } }) =>
    Promise.resolve(
      args.where.userId === params.actorUserId && params.orgRole
        ? {
            id: 'om-actor',
            orgId: 'org-1',
            userId: params.actorUserId,
            role: params.orgRole,
            createdAt: now,
            updatedAt: now,
          }
        : null,
    ),
  );
  prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
  prisma.teamMember.findFirst.mockImplementation((args: { where: { userId: string } }) => {
    if (args.where.userId === params.actorUserId) {
      return Promise.resolve(params.teamRole ? { teamRole: params.teamRole } : null);
    }
    return Promise.resolve({ id: 'tm-target', teamRole: 'member' });
  });
  prisma.teamMember.update.mockResolvedValue({
    id: 'tm-target',
    teamId: 'team-1',
    userId: 'u-target',
    teamRole: 'admin',
    createdAt: now,
    updatedAt: now,
  });
}

function changeRole(prisma: PrismaClient, actorUserId: string, config: ClientConfig, teamRole = 'admin') {
  return changeTeamMemberRole(
    {
      orgId: 'org-1',
      teamId: 'team-1',
      domain: 'acme.example.com',
      actorUserId,
      userId: 'u-target',
      teamRole,
      config,
    },
    { prisma },
  );
}

describe('Team service: the corrected roster gate (constraint #1)', () => {
  useTeamServiceTestEnv();

  it('lets a TEAM admin who is only an org member change their own team roster', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-team-admin', orgRole: 'member', teamRole: 'admin' });

    await expect(changeRole(prisma, 'u-team-admin', makeConfig())).resolves.toMatchObject({
      teamId: 'team-1',
    });
    expect(prisma.teamMember.update).toHaveBeenCalled();
  });

  it('lets a TEAM owner who is only an org member do the same', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-team-owner', orgRole: 'member', teamRole: 'owner' });

    await expect(changeRole(prisma, 'u-team-owner', makeConfig())).resolves.toMatchObject({
      teamId: 'team-1',
    });
  });

  it('still refuses an org member with no standing in the team', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-plain', orgRole: 'member', teamRole: null });

    await expect(changeRole(prisma, 'u-plain', makeConfig())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    expect(prisma.teamMember.update).not.toHaveBeenCalled();
  });

  it('still refuses a plain TEAM member', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-plain', orgRole: 'member', teamRole: 'member' });

    await expect(changeRole(prisma, 'u-plain', makeConfig())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('keeps the org-manager reach-down: an org admin with no team membership still passes', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-org-admin', orgRole: 'admin', teamRole: null });

    await expect(changeRole(prisma, 'u-org-admin', makeConfig())).resolves.toMatchObject({
      teamId: 'team-1',
    });
  });

  it('leaves team creation org-scoped — there is no team to stand in yet', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(ORG_ROW);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'om-actor',
      orgId: 'org-1',
      userId: 'u-team-admin',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    });
    // Standing in some OTHER team must not buy the right to create a new one.
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'admin' });

    await expect(
      createTeam(
        {
          orgId: 'org-1',
          domain: 'acme.example.com',
          actorUserId: 'u-team-admin',
          name: 'Platform',
          config: makeConfig(),
        },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.team.create).not.toHaveBeenCalled();
  });
});

describe('Team service: a domain-configured vocabulary and grant table', () => {
  useTeamServiceTestEnv();

  const customConfig = makeConfig({
    org_roles: ['owner', 'admin', 'member'],
    team_roles: ['owner', 'editor', 'reader'],
    role_grants: {
      team: { editor: ['members.manage'] },
      org: { admin: ['teams.manage'] },
    },
  });

  it('grants a custom team role the roster capability the domain gave it', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-editor', orgRole: 'member', teamRole: 'editor' });

    await expect(changeRole(prisma, 'u-editor', customConfig, 'reader')).resolves.toMatchObject({
      teamId: 'team-1',
    });
  });

  it('gives a custom role the table does not mention nothing at all', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-reader', orgRole: 'member', teamRole: 'reader' });

    await expect(changeRole(prisma, 'u-reader', customConfig, 'reader')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('takes the roster away from an org admin the table only granted teams.manage', async () => {
    // The configured table REPLACES the legacy default rather than adding to it, so a domain can
    // narrow authority as well as widen it.
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-org-admin', orgRole: 'admin', teamRole: null });

    await expect(changeRole(prisma, 'u-org-admin', customConfig, 'reader')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('never locks the owner out, whatever the table says', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-owner', orgRole: 'owner', teamRole: null });

    await expect(changeRole(prisma, 'u-owner', customConfig, 'reader')).resolves.toMatchObject({
      teamId: 'team-1',
    });
  });

  it('validates the written role against the configured vocabulary, not the canonical three', async () => {
    const prisma = makePrismaMock();
    seedRoster(prisma, { actorUserId: 'u-owner', orgRole: 'owner', teamRole: null });

    // `admin` is not in this domain's `team_roles`.
    await expect(changeRole(prisma, 'u-owner', customConfig, 'admin')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    // …and `editor` is not in the default one.
    await expect(changeRole(prisma, 'u-owner', makeConfig(), 'editor')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  });
});
