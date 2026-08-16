import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../../src/app.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  signAccessToken,
} from '../helpers/org-user-endpoints-helper.js';

/**
 * Wave 1 of `Docs/plans/2026-08-16-configurable-roles-and-capabilities.md` and its org-scope
 * follow-up, over HTTP.
 *
 * Two things the mocked service tests cannot prove on their own: that the corrected roster gate is
 * reachable through the real route chain (config verification, org-role guard, tenant RLS
 * transaction), and that a `role_grants` table travelling in a genuinely signed config JWT decides
 * those routes — at org scope (`organisation.manage`, `members.manage`) as well as team scope.
 */

const DOMAIN = 'role-grants.example.com';
const CONFIG_URL = `https://${DOMAIN}/auth-config`;

type Ids = {
  orgId: string;
  teamId: string;
  ownerId: string;
  actorId: string;
};

describe.skipIf(!hasDatabase)('/org team gates resolve role_grants', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let app: FastifyInstance | undefined;
  let domainHash: string;

  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.SHARED_SECRET =
      process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  });

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    if (app) await app.close();
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await clearOrgTestDatabase(handle);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Serve `orgFeatures` as this domain's signed config, and build the app against it. */
  async function serveConfig(orgFeatures: Record<string, unknown>): Promise<void> {
    const configJwt = await createSignedConfigJwt(process.env.SHARED_SECRET!, orgFeatures, DOMAIN);
    // A fresh Response per call — bodies are single-use and both startup and every request read it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(configJwt, { status: 200 })));
    if (!app) {
      app = await createApp();
      await app.ready();
    }
    domainHash = await seedDomainSecret(handle!.prisma, DOMAIN);
  }

  function token(userId: string, orgId: string, orgRole: string, teamRoles: Record<string, string>) {
    return signAccessToken({
      subject: userId,
      domain: DOMAIN,
      secret: process.env.SHARED_SECRET!,
      issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
      org: { orgId, orgRole, teams: Object.keys(teamRoles), team_roles: teamRoles },
    });
  }

  function url(path: string): string {
    return `/org${path}?domain=${encodeURIComponent(DOMAIN)}&config_url=${encodeURIComponent(CONFIG_URL)}`;
  }

  /**
   * One org, one team, an owner, a target member, and `actorTeamRole`-standing for the actor. Seeded
   * straight through Prisma so the fixture is not itself subject to the gate under test.
   */
  async function seed(params: {
    actorOrgRole: string;
    actorTeamRole: string | null;
  }): Promise<Ids> {
    const prisma = handle!.prisma;
    const owner = await createTestUser(handle!, `owner-${Date.now()}@example.com`);
    const actor = await createTestUser(handle!, `actor-${Date.now()}@example.com`);
    const target = await createTestUser(handle!, `target-${Date.now()}@example.com`);

    const org = await prisma.organisation.create({
      data: { domain: DOMAIN, name: 'Role Grants Co', slug: `rg-${Date.now()}`, ownerId: owner.id },
    });
    const team = await prisma.team.create({
      data: { orgId: org.id, name: 'Platform', slug: `platform-${Date.now()}` },
    });

    await prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: 'owner' },
        { orgId: org.id, userId: actor.id, role: params.actorOrgRole },
        { orgId: org.id, userId: target.id, role: 'member' },
      ],
    });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: target.id, teamRole: 'member' },
    });
    if (params.actorTeamRole) {
      await prisma.teamMember.create({
        data: { teamId: team.id, userId: actor.id, teamRole: params.actorTeamRole },
      });
    }

    return { orgId: org.id, teamId: team.id, ownerId: owner.id, actorId: actor.id };
  }

  async function changeTargetRole(ids: Ids, actorToken: string, teamRole: string) {
    const target = await handle!.prisma.teamMember.findFirstOrThrow({
      where: { teamId: ids.teamId, teamRole: 'member' },
      select: { userId: true },
    });
    return app!.inject({
      method: 'PUT',
      url: url(`/organisations/${ids.orgId}/teams/${ids.teamId}/members/${target.userId}`),
      headers: {
        authorization: `Bearer ${domainHash}`,
        'x-uoa-access-token': `Bearer ${actorToken}`,
      },
      payload: { teamRole },
    });
  }

  describe('with no role_grants (the legacy default table)', () => {
    beforeEach(async () => {
      await serveConfig({ enabled: true });
    });

    it('lets a team admin who is only an org member change their own team roster', async () => {
      const ids = await seed({ actorOrgRole: 'member', actorTeamRole: 'admin' });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'member', { [ids.teamId]: 'admin' }),
        'admin',
      );

      expect(res.statusCode).toBe(200);
    });

    it('still refuses an org member with no standing in the team', async () => {
      const ids = await seed({ actorOrgRole: 'member', actorTeamRole: null });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'member', {}),
        'admin',
      );

      expect(res.statusCode).toBe(403);
    });

    it('keeps the org-manager reach-down for an org admin outside the team', async () => {
      const ids = await seed({ actorOrgRole: 'admin', actorTeamRole: null });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'admin', {}),
        'admin',
      );

      expect(res.statusCode).toBe(200);
    });

    it('keeps team creation org-scoped — team standing does not authorise it', async () => {
      const ids = await seed({ actorOrgRole: 'member', actorTeamRole: 'admin' });
      const res = await app!.inject({
        method: 'POST',
        url: url(`/organisations/${ids.orgId}/teams`),
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${await token(ids.actorId, ids.orgId, 'member', {
            [ids.teamId]: 'admin',
          })}`,
        },
        payload: { name: 'Second Team' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects a team role outside the default vocabulary', async () => {
      const ids = await seed({ actorOrgRole: 'owner', actorTeamRole: null });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'owner', {}),
        'editor',
      );

      expect(res.statusCode).toBe(400);
    });
  });

  describe('with a domain-authored vocabulary and grant table', () => {
    beforeEach(async () => {
      await serveConfig({
        enabled: true,
        org_roles: ['owner', 'admin', 'member'],
        team_roles: ['owner', 'editor', 'reader'],
        role_grants: {
          team: { editor: ['members.manage'] },
          org: { admin: ['teams.manage'] },
        },
      });
    });

    it('grants a custom team role the roster capability the domain gave it', async () => {
      const ids = await seed({ actorOrgRole: 'member', actorTeamRole: 'editor' });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'member', { [ids.teamId]: 'editor' }),
        'reader',
      );

      expect(res.statusCode).toBe(200);
    });

    it('gives a custom role the table does not mention nothing at all', async () => {
      const ids = await seed({ actorOrgRole: 'member', actorTeamRole: 'reader' });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'member', { [ids.teamId]: 'reader' }),
        'reader',
      );

      expect(res.statusCode).toBe(403);
    });

    it('takes the roster away from an org admin this table only gave teams.manage', async () => {
      const ids = await seed({ actorOrgRole: 'admin', actorTeamRole: null });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'admin', {}),
        'reader',
      );

      expect(res.statusCode).toBe(403);
    });

    it('never locks the owner out, whatever the table says', async () => {
      const ids = await seed({ actorOrgRole: 'owner', actorTeamRole: null });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'owner', {}),
        'reader',
      );

      expect(res.statusCode).toBe(200);
    });

    it('validates the written role against the configured vocabulary', async () => {
      const ids = await seed({ actorOrgRole: 'owner', actorTeamRole: null });
      const res = await changeTargetRole(
        ids,
        await token(ids.actorId, ids.orgId, 'owner', {}),
        'admin',
      );

      expect(res.statusCode).toBe(400);
    });
  });

  /**
   * The org-scope gates. `organisation.manage` (rename) and `members.manage` (roster) used to be
   * one hard-coded `owner|admin` comparison in three services that could not see the config at
   * all; these drive them through the same real route chain.
   */
  describe('org-scope gates', () => {
    async function renameOrg(ids: Ids, actorToken: string) {
      return app!.inject({
        method: 'PUT',
        url: url(`/organisations/${ids.orgId}`),
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${actorToken}`,
        },
        payload: { name: `Renamed ${Date.now()}` },
      });
    }

    async function deactivateTarget(ids: Ids, actorToken: string) {
      const target = await handle!.prisma.orgMember.findFirstOrThrow({
        where: { orgId: ids.orgId, role: 'member', userId: { not: ids.actorId } },
        select: { userId: true },
      });
      return app!.inject({
        method: 'POST',
        url: url(`/organisations/${ids.orgId}/members/${target.userId}/deactivate`),
        headers: {
          authorization: `Bearer ${domainHash}`,
          'x-uoa-access-token': `Bearer ${actorToken}`,
        },
      });
    }

    describe('with no role_grants (the legacy default table)', () => {
      beforeEach(async () => {
        await serveConfig({ enabled: true });
      });

      it('lets an org admin rename the organisation and run the roster', async () => {
        const ids = await seed({ actorOrgRole: 'admin', actorTeamRole: null });
        const actorToken = await token(ids.actorId, ids.orgId, 'admin', {});

        expect((await renameOrg(ids, actorToken)).statusCode).toBe(200);
        expect((await deactivateTarget(ids, actorToken)).statusCode).toBe(200);
      });

      it('still refuses a plain org member', async () => {
        const ids = await seed({ actorOrgRole: 'member', actorTeamRole: null });
        const actorToken = await token(ids.actorId, ids.orgId, 'member', {});

        expect((await renameOrg(ids, actorToken)).statusCode).toBe(403);
        expect((await deactivateTarget(ids, actorToken)).statusCode).toBe(403);
      });

      it('never reaches up from team standing — a team admin is not an org manager', async () => {
        // The mirror of the org-manager reach-down: an org grant covers every team, but team
        // standing confers nothing over the tenant containing the team.
        const ids = await seed({ actorOrgRole: 'member', actorTeamRole: 'admin' });
        const actorToken = await token(ids.actorId, ids.orgId, 'member', {
          [ids.teamId]: 'admin',
        });

        expect((await renameOrg(ids, actorToken)).statusCode).toBe(403);
        expect((await deactivateTarget(ids, actorToken)).statusCode).toBe(403);
      });
    });

    describe('with a domain-authored grant table splitting the two', () => {
      beforeEach(async () => {
        await serveConfig({
          enabled: true,
          org_roles: ['owner', 'member', 'registrar', 'steward'],
          role_grants: {
            org: { registrar: ['organisation.manage'], steward: ['members.manage'] },
          },
        });
      });

      it('lets `registrar` rename but not touch the roster', async () => {
        const ids = await seed({ actorOrgRole: 'registrar', actorTeamRole: null });
        const actorToken = await token(ids.actorId, ids.orgId, 'registrar', {});

        expect((await renameOrg(ids, actorToken)).statusCode).toBe(200);
        expect((await deactivateTarget(ids, actorToken)).statusCode).toBe(403);
      });

      it('lets `steward` run the roster but not rename', async () => {
        const ids = await seed({ actorOrgRole: 'steward', actorTeamRole: null });
        const actorToken = await token(ids.actorId, ids.orgId, 'steward', {});

        expect((await deactivateTarget(ids, actorToken)).statusCode).toBe(200);
        expect((await renameOrg(ids, actorToken)).statusCode).toBe(403);
      });

      it('gives a role the table does not mention nothing at all', async () => {
        const ids = await seed({ actorOrgRole: 'member', actorTeamRole: null });
        const actorToken = await token(ids.actorId, ids.orgId, 'member', {});

        expect((await renameOrg(ids, actorToken)).statusCode).toBe(403);
        expect((await deactivateTarget(ids, actorToken)).statusCode).toBe(403);
      });

      it('never locks the owner out, whatever the table says', async () => {
        const ids = await seed({ actorOrgRole: 'owner', actorTeamRole: null });
        const actorToken = await token(ids.actorId, ids.orgId, 'owner', {});

        expect((await renameOrg(ids, actorToken)).statusCode).toBe(200);
        expect((await deactivateTarget(ids, actorToken)).statusCode).toBe(200);
      });
    });
  });
});
