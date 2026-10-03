// Exercise tenant boundaries with the production uoa_app/uoa_admin RLS roles.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestUser, hasDatabase, signAccessToken } from '../helpers/org-user-endpoints-helper.js';
import { ATTACKER_DOMAIN, VICTIM_DOMAIN, useBackendRlsFixture } from '../helpers/backend-rls-fixture.js';

describe.skipIf(!hasDatabase)('/org/* under production RLS roles (uoa_app)', () => {
  const { state, stubConfigs, url, seedOrg } = useBackendRlsFixture();
  // ===================================================================
  // C1 — cross-tenant escape through the access-request routes.
  // ===================================================================
  describe('access requests are bound to the calling domain', () => {
    /**
     * The escape: the access-request routes put the raw path `:orgId` into
     * `app.org_id` and check it only against ids the CALLER's own signed config
     * supplied. The access-request RLS policies key on `app.org_id` alone and
     * never consider `app.domain`, so they are no backstop — the attacker names
     * the victim's ids in its own config and the policy happily agrees.
     */
    it('does not let a domain read another domain\'s access requests', async () => {
      const victim = await seedOrg({
        domain: VICTIM_DOMAIN,
        name: 'Victim Co',
        slug: 'victim-co',
        ownerEmail: 'victim-owner@example.com',
      });
      await state.handle!.prisma.accessRequest.create({
        data: {
          orgId: victim.orgId,
          teamId: victim.teamId,
          email: 'victim-applicant@example.com',
          requestName: 'Victim Applicant',
          status: 'PENDING',
          lastRequestedAt: new Date(),
        },
      });

      // The attacker signs a config naming the VICTIM's org/team as its own
      // access-request target.
      await stubConfigs({
        attackerAccessRequests: {
          enabled: true,
          target_org_id: victim.orgId,
          target_team_id: victim.teamId,
        },
      });

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'GET',
        url: url(`/org/organisations/${victim.orgId}/teams/${victim.teamId}/access-requests`),
        headers: { authorization: `Bearer ${bearer}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.payload).not.toContain('victim-applicant@example.com');
    });

    it('does not let a domain reject another domain\'s access request', async () => {
      const victim = await seedOrg({
        domain: VICTIM_DOMAIN,
        name: 'Victim Co',
        slug: 'victim-co',
        ownerEmail: 'victim-owner@example.com',
      });
      const accessRequest = await state.handle!.prisma.accessRequest.create({
        data: {
          orgId: victim.orgId,
          teamId: victim.teamId,
          email: 'victim-applicant@example.com',
          status: 'PENDING',
          lastRequestedAt: new Date(),
        },
        select: { id: true },
      });

      await stubConfigs({
        attackerAccessRequests: {
          enabled: true,
          target_org_id: victim.orgId,
          target_team_id: victim.teamId,
        },
      });

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url(
          `/org/organisations/${victim.orgId}/teams/${victim.teamId}/access-requests/${accessRequest.id}/reject`,
        ),
        headers: { authorization: `Bearer ${bearer}` },
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      const after = await state.handle!.prisma.accessRequest.findUniqueOrThrow({
        where: { id: accessRequest.id },
        select: { status: true },
      });
      expect(after.status).toBe('PENDING');
    });

    it('still serves a domain its own access requests', async () => {
      const own = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Own Co',
        slug: 'own-co',
        ownerEmail: 'own-owner@example.com',
      });
      await state.handle!.prisma.accessRequest.create({
        data: {
          orgId: own.orgId,
          teamId: own.teamId,
          email: 'own-applicant@example.com',
          status: 'PENDING',
          lastRequestedAt: new Date(),
        },
      });

      await stubConfigs({
        attackerAccessRequests: {
          enabled: true,
          target_org_id: own.orgId,
          target_team_id: own.teamId,
        },
      });

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'GET',
        url: url(`/org/organisations/${own.orgId}/teams/${own.teamId}/access-requests`),
        headers: { authorization: `Bearer ${bearer}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { email: string }[] };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].email).toBe('own-applicant@example.com');
    });
  });

  // ===================================================================
  // B1 — a present-but-blank user token must never become backend authority.
  // ===================================================================
  describe('blank X-UOA-Access-Token', () => {
    /**
     * A user token whose value carries no credential. Wider than plain ASCII
     * whitespace on purpose: `trim()` also strips NBSP, form feed and vertical
     * tab, and the `Bearer` prefix is stripped case-insensitively before the
     * blank check, so each of those is its own way for "present" to look
     * "absent" to a careless reader.
     */
    const BLANK_TOKEN_SHAPES: Array<[string, string]> = [
      ['empty string', ''],
      ['single space', ' '],
      ['spaces', '   '],
      ['tab', '\t'],
      ['newline', '\n'],
      ['carriage return', '\r'],
      ['form feed', '\f'],
      ['vertical tab', '\v'],
      ['no-break space (U+00A0)', ' '],
      ['Bearer + space', 'Bearer '],
      ['Bearer + tab', 'Bearer\t'],
      ['lowercase bearer + spaces', 'bearer   '],
      ['uppercase BEARER + space', 'BEARER '],
    ];

    async function seedBlankOwner() {
      const owner = await createTestUser(state.handle!, 'blank-owner@example.com');
      await state.handle!.prisma.domainRole.create({
        data: { domain: ATTACKER_DOMAIN, userId: owner.id },
      });
      await stubConfigs();
      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);
      return { app, owner, bearer };
    }

    it.each(BLANK_TOKEN_SHAPES)(
      'does not grant whole-tenant authority through a real route (%s)',
      async (_label, headerValue) => {
        const { app, owner, bearer } = await seedBlankOwner();

        const res = await app.inject({
          method: 'POST',
          url: url('/org/organisations'),
          headers: {
            authorization: `Bearer ${bearer}`,
            'x-uoa-access-token': headerValue,
          },
          payload: { name: 'Anonymous Org', owner_user_id: owner.id },
        });

        expect(res.statusCode).toBe(401);
        expect(
          await state.handle!.prisma.organisation.count({ where: { domain: ATTACKER_DOMAIN } }),
        ).toBe(0);
      },
    );

    it('still accepts the same call when the header is omitted entirely', async () => {
      const { app, owner, bearer } = await seedBlankOwner();

      const res = await app.inject({
        method: 'POST',
        url: url('/org/organisations'),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { name: 'Backend Org', owner_user_id: owner.id },
      });

      expect(res.statusCode).toBe(200);
    });

    // The route that actually LEAKED. `POST` was guarded all along; `GET
    // /org/organisations` ran no guard, so none of the shapes above reached the
    // blank-token blocker and every one of them answered 200 with the whole
    // domain's organisation list — the new `app.domain_backend` RLS branch is
    // what turned that from "zero rows in production" into live data.
    it.each(BLANK_TOKEN_SHAPES)(
      'does not list the domain\'s organisations for a blank token (%s)',
      async (_label, headerValue) => {
        await seedOrg({
          domain: ATTACKER_DOMAIN,
          name: 'Should Stay Hidden',
          slug: 'should-stay-hidden',
          ownerEmail: 'hidden-owner@example.com',
        });
        await stubConfigs();
        const app = await createApp();
        await app.ready();
        const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

        const res = await app.inject({
          method: 'GET',
          url: url('/org/organisations'),
          headers: {
            authorization: `Bearer ${bearer}`,
            'x-uoa-access-token': headerValue,
          },
        });

        expect(res.statusCode).toBe(401);
        expect(res.body).not.toContain('Should Stay Hidden');
      },
    );

    // ...and a token that WOULD verify is refused just the same. The route has
    // no user mode, so accepting one would be inventing a second principal on a
    // domain-wide read.
    it('does not list the domain\'s organisations for a valid user token', async () => {
      const seeded = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Members Only',
        slug: 'members-only',
        ownerEmail: 'members-only-owner@example.com',
      });
      await stubConfigs();
      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);
      const token = await signAccessToken({
        subject: seeded.ownerId,
        domain: ATTACKER_DOMAIN,
        secret: process.env.SHARED_SECRET!,
        issuer: process.env.AUTH_SERVICE_IDENTIFIER!,
        org: { orgId: seeded.orgId, orgRole: 'owner' },
      });

      const res = await app.inject({
        method: 'GET',
        url: url('/org/organisations'),
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-uoa-access-token': `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain('Members Only');
    });
  });


});
