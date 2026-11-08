import { describe, expect, it, vi } from 'vitest';

import { lookupPublicTeams } from '../../src/services/public-team-lookup.service.js';

const updatedAt = new Date('2026-11-08T10:00:00.000Z');

function row(id: string, orgId = 'org-1') {
  return {
    id,
    name: `Team ${id}`,
    slug: `slug-${id}`,
    updatedAt,
    org: { id: orgId, name: `Org ${orgId}`, slug: `org-slug-${orgId}` },
  };
}

describe('lookupPublicTeams', () => {
  it('reads only the asked ids, only ACTIVE teams in ACTIVE organisations, and only display columns', async () => {
    const findMany = vi.fn(async () => [row('b'), row('a')]);

    await lookupPublicTeams({ team: { findMany } } as never, ['a', 'b', 'a'], 'https://uoa.example');

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['a', 'b'] },
        lifecycleStatus: 'ACTIVE',
        org: { lifecycleStatus: 'ACTIVE' },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        updatedAt: true,
        org: { select: { id: true, name: true, slug: true } },
      },
    });
  });

  it('answers in request order, once per id, omitting ids the read did not return', async () => {
    const findMany = vi.fn(async () => [row('c', 'org-2'), row('a')]);

    const teams = await lookupPublicTeams(
      { team: { findMany } } as never,
      ['c', 'missing', 'a', 'c'],
      'https://uoa.example',
    );

    expect(teams).toEqual([
      {
        teamId: 'c', teamName: 'Team c', teamSlug: 'slug-c',
        orgId: 'org-2', orgName: 'Org org-2', orgSlug: 'org-slug-org-2',
        avatarUrl: `https://uoa.example/teams/c/avatar?v=${updatedAt.getTime().toString(36)}`,
      },
      {
        teamId: 'a', teamName: 'Team a', teamSlug: 'slug-a',
        orgId: 'org-1', orgName: 'Org org-1', orgSlug: 'org-slug-org-1',
        avatarUrl: `https://uoa.example/teams/a/avatar?v=${updatedAt.getTime().toString(36)}`,
      },
    ]);
  });

  it('does not touch the database for an empty batch', async () => {
    const findMany = vi.fn();

    await expect(lookupPublicTeams({ team: { findMany } } as never, [])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
