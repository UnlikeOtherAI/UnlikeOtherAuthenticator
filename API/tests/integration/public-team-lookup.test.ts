// POST /public/teams/lookup against a real database, with the API on the production
// uoa_app/uoa_admin roles: the lookup is a cross-organisation read and must not depend on any
// tenant context the anonymous caller does not have.
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { ATTACKER_DOMAIN, VICTIM_DOMAIN, useBackendRlsFixture } from '../helpers/backend-rls-fixture.js';
import { hasDatabase } from '../helpers/org-user-endpoints-helper.js';

describe.skipIf(!hasDatabase)('POST /public/teams/lookup under production RLS roles', () => {
  const { state, seedOrg } = useBackendRlsFixture();

  it('names active teams across organisations and domains and omits everything else', async () => {
    const first = await seedOrg({
      domain: ATTACKER_DOMAIN, name: 'First Org', slug: 'first-org', ownerEmail: 'first@example.com',
    });
    const second = await seedOrg({
      domain: VICTIM_DOMAIN, name: 'Second Org', slug: 'second-org', ownerEmail: 'second@example.com',
    });
    const prisma = state.handle!.prisma;
    const sales = await prisma.team.create({
      data: { orgId: first.orgId, name: 'Sales', slug: 'sales' }, select: { id: true },
    });
    const disabled = await prisma.team.create({
      data: { orgId: first.orgId, name: 'Paused', slug: 'paused', lifecycleStatus: 'DISABLED' },
      select: { id: true },
    });
    const deleted = await prisma.team.create({
      data: { orgId: second.orgId, name: 'Gone', slug: 'gone', lifecycleStatus: 'DELETED' },
      select: { id: true },
    });
    const disabledOrg = await seedOrg({
      domain: VICTIM_DOMAIN, name: 'Disabled Org', slug: 'disabled-org', ownerEmail: 'third@example.com',
    });
    await prisma.organisation.update({
      where: { id: disabledOrg.orgId }, data: { lifecycleStatus: 'DISABLED' },
    });

    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/public/teams/lookup',
        payload: {
          teamIds: [
            second.teamId, 'unknown-team-id', sales.id, disabled.id, deleted.id,
            disabledOrg.teamId, first.teamId, second.teamId,
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const { teams } = response.json() as { teams: Array<Record<string, string>> };
      expect(teams.map(({ avatarUrl, ...rest }) => {
        expect(avatarUrl).toMatch(new RegExp(`/teams/${rest.teamId}/avatar\\?v=[0-9a-z]+$`));
        return rest;
      })).toEqual([
        {
          teamId: second.teamId, teamName: 'General', teamSlug: 'general',
          orgId: second.orgId, orgName: 'Second Org', orgSlug: 'second-org',
        },
        {
          teamId: sales.id, teamName: 'Sales', teamSlug: 'sales',
          orgId: first.orgId, orgName: 'First Org', orgSlug: 'first-org',
        },
        {
          teamId: first.teamId, teamName: 'General', teamSlug: 'general',
          orgId: first.orgId, orgName: 'First Org', orgSlug: 'first-org',
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('publishes the route in /api and /llm', async () => {
    const app = await createApp();
    await app.ready();
    try {
      const api = (await app.inject({ method: 'GET', url: '/api' })).json() as {
        endpoints: Array<{ method: string; path: string; auth?: string }>;
      };
      expect(api.endpoints).toContainEqual(expect.objectContaining({
        method: 'POST', path: '/public/teams/lookup', auth: 'none (public)',
      }));
      const llm = await app.inject({ method: 'GET', url: '/llm' });
      expect(llm.body).toContain('POST /public/teams/lookup');
    } finally {
      await app.close();
    }
  });
});
