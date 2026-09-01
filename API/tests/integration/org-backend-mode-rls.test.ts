// `/org/*` behaviour that only exists under the PRODUCTION row-level-security
// roles.
//
// `org-backend-mode.test.ts` proves the backend-mode chain end-to-end, but it
// connects as the Postgres superuser — which bypasses RLS entirely. Several
// tenant-boundary and uniqueness properties are therefore invisible to it: a
// policy that keys on `app.org_id` alone does not stop a cross-tenant read, and
// a "does this user already belong to a sibling org?" probe cannot see its
// siblings when the transaction is scoped to one org.
//
// Every case below connects as `uoa_app` (non-BYPASSRLS, exactly the role the
// API runs as in production) with `uoa_admin` for the pre-context/admin paths,
// so the policies in `20260423000001_rls_enable_policies` are enforced.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { ORG_AUDIT_ACTOR_METADATA_KEY } from '../../src/services/org-audit-log.service.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createRlsTestDb } from '../helpers/test-db.js';
import {
  clearOrgTestDatabase,
  createSignedConfigJwt,
  createTestUser,
  hasDatabase,
  signAccessToken,
  type OrgListRecord,
  type OrgRecord,
} from '../helpers/org-user-endpoints-helper.js';

const ATTACKER_DOMAIN = 'rls-attacker.example.com';
const ATTACKER_CONFIG_URL = `https://${ATTACKER_DOMAIN}/auth-config`;
const VICTIM_DOMAIN = 'rls-victim.example.com';
const VICTIM_CONFIG_URL = `https://${VICTIM_DOMAIN}/auth-config`;

describe.skipIf(!hasDatabase)('/org/* under production RLS roles (uoa_app)', () => {
  let handle: Awaited<ReturnType<typeof createRlsTestDb>>;

  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalAdminUrl = process.env.DATABASE_ADMIN_URL;

  beforeAll(async () => {
    handle = await createRlsTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    // The app now runs as the real RLS role; only the test's own seeding uses
    // `handle.prisma` (superuser).
    process.env.DATABASE_URL = handle.appDatabaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.adminDatabaseUrl;
  });

  afterAll(async () => {
    await disconnectPrisma();
    process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalAdminUrl === undefined) delete process.env.DATABASE_ADMIN_URL;
    else process.env.DATABASE_ADMIN_URL = originalAdminUrl;
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.orgAuditLog.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.accessRequest.deleteMany();
    await clearOrgTestDatabase(handle);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Serve each domain its own signed config. The attacker's config is where the
   * cross-tenant probe lives: it is signed by the attacker, so the attacker
   * chooses every value in it — including ids that belong to another tenant.
   */
  async function stubConfigs(opts?: {
    attackerAccessRequests?: Record<string, unknown>;
    victimAccessRequests?: Record<string, unknown>;
    allowUserCreateOrg?: boolean;
  }): Promise<void> {
    const attackerJwt = await createSignedConfigJwt(
      process.env.SHARED_SECRET!,
      {
        backend_org_management: true,
        ...(opts?.allowUserCreateOrg === undefined
          ? {}
          : { allow_user_create_org: opts.allowUserCreateOrg }),
      },
      ATTACKER_DOMAIN,
      opts?.attackerAccessRequests,
    );
    const victimJwt = await createSignedConfigJwt(
      process.env.SHARED_SECRET!,
      { backend_org_management: true },
      VICTIM_DOMAIN,
      opts?.victimAccessRequests,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes(VICTIM_DOMAIN)) return new Response(victimJwt, { status: 200 });
        return new Response(attackerJwt, { status: 200 });
      }),
    );
  }

  function url(path: string, domain = ATTACKER_DOMAIN): string {
    const configUrl = domain === VICTIM_DOMAIN ? VICTIM_CONFIG_URL : ATTACKER_CONFIG_URL;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}domain=${encodeURIComponent(domain)}&config_url=${encodeURIComponent(configUrl)}`;
  }

  /** Seed an org + default team + owner directly, bypassing the API. */
  async function seedOrg(params: {
    domain: string;
    name: string;
    slug: string;
    ownerEmail: string;
  }): Promise<{ orgId: string; teamId: string; ownerId: string }> {
    const owner = await createTestUser(handle!, params.ownerEmail);
    const org = await handle!.prisma.organisation.create({
      data: {
        domain: params.domain,
        name: params.name,
        slug: params.slug,
        ownerId: owner.id,
      },
      select: { id: true },
    });
    const team = await handle!.prisma.team.create({
      data: { orgId: org.id, name: 'General', slug: 'general', isDefault: true },
      select: { id: true },
    });
    await handle!.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    await handle!.prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id } });
    // Login writes this row (`ensureDomainRoleForUser`); backend org-create now
    // requires it as proof the named owner belongs to the calling domain.
    await handle!.prisma.domainRole.create({
      data: { domain: params.domain, userId: owner.id },
    });
    return { orgId: org.id, teamId: team.id, ownerId: owner.id };
  }

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
      await handle!.prisma.accessRequest.create({
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
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

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
      const accessRequest = await handle!.prisma.accessRequest.create({
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
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url(
          `/org/organisations/${victim.orgId}/teams/${victim.teamId}/access-requests/${accessRequest.id}/reject`,
        ),
        headers: { authorization: `Bearer ${bearer}` },
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      const after = await handle!.prisma.accessRequest.findUniqueOrThrow({
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
      await handle!.prisma.accessRequest.create({
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
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

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
      const owner = await createTestUser(handle!, 'blank-owner@example.com');
      await handle!.prisma.domainRole.create({
        data: { domain: ATTACKER_DOMAIN, userId: owner.id },
      });
      await stubConfigs();
      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);
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
          await handle!.prisma.organisation.count({ where: { domain: ATTACKER_DOMAIN } }),
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
        const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

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
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);
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

  // ===================================================================
  // C3 — the backend-only list route must actually return rows under RLS.
  // ===================================================================
  describe('GET /org/organisations', () => {
    it('lists the calling domain\'s organisations under RLS', async () => {
      await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Listed One',
        slug: 'listed-one',
        ownerEmail: 'listed-one@example.com',
      });
      await seedOrg({
        domain: VICTIM_DOMAIN,
        name: 'Not Listed',
        slug: 'not-listed',
        ownerEmail: 'not-listed@example.com',
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'GET',
        url: url('/org/organisations'),
        headers: { authorization: `Bearer ${bearer}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: OrgListRecord[] };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Listed One');
      expect(body.data[0].domain).toBe(ATTACKER_DOMAIN);
    });
  });

  // ===================================================================
  // C2 — one user may own or join several organisations on a domain.
  // ===================================================================
  describe('multiple organisations per user per domain', () => {
    it('allows an existing member to own a second org', async () => {
      const first = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'First Org',
        slug: 'first-org',
        ownerEmail: 'already-placed@example.com',
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url('/org/organisations'),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { name: 'Second Org', owner_user_id: first.ownerId },
      });

      expect(res.statusCode).toBe(200);
      const orgCount = await handle!.prisma.organisation.count({
        where: { domain: ATTACKER_DOMAIN },
      });
      expect(orgCount).toBe(2);
    });

    it('allows a user to join a sibling org', async () => {
      const first = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'First Org',
        slug: 'first-org',
        ownerEmail: 'already-placed@example.com',
      });
      const second = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Second Org',
        slug: 'second-org',
        ownerEmail: 'second-owner@example.com',
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${second.orgId}/members`),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { userId: first.ownerId, role: 'member' },
      });

      expect(res.statusCode).toBe(200);
      const memberships = await handle!.prisma.orgMember.count({
        where: { userId: first.ownerId, status: 'ACTIVE' },
      });
      expect(memberships).toBe(2);
    });
  });

  // Exact `(orgId, userId)` uniqueness is still enforced, but active memberships may now span
  // organisations. The following direct database tests exercise that intended shape under the
  // BYPASSRLS test connection as well.
  describe('multiple organisations per user per domain (database)', () => {
    it('allows a second active membership even on a BYPASSRLS connection', async () => {
      const first = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'First Org',
        slug: 'first-org',
        ownerEmail: 'already-placed@example.com',
      });
      const second = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Second Org',
        slug: 'second-org',
        ownerEmail: 'second-owner@example.com',
      });

      // `handle.prisma` is the superuser connection — it bypasses RLS and skips every service
      // check, so this proves the retired cross-organisation unique index is gone.
      const membership = await handle!.prisma.orgMember.create({
        data: { orgId: second.orgId, userId: first.ownerId, role: 'member' },
      });
      expect(membership.id).toBeTruthy();

      expect(
        await handle!.prisma.orgMember.count({
          where: { userId: first.ownerId, status: 'ACTIVE' },
        }),
      ).toBe(2);
    });

    it('allows a tombstoned membership to be reactivated alongside an active sibling', async () => {
      const first = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'First Org',
        slug: 'first-org',
        ownerEmail: 'already-placed@example.com',
      });
      const second = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Second Org',
        slug: 'second-org',
        ownerEmail: 'second-owner@example.com',
      });

      // Statuses are tombstones (design 4.1), not memberships — a REMOVED row
      // must remain insertable so history survives.
      const removed = await handle!.prisma.orgMember.create({
        data: {
          orgId: second.orgId,
          userId: first.ownerId,
          role: 'member',
          status: 'REMOVED',
          statusChangedAt: new Date(),
        },
        select: { id: true },
      });
      expect(removed.id).toBeTruthy();

      const reactivated = await handle!.prisma.orgMember.update({
        where: { id: removed.id },
        data: { status: 'ACTIVE' },
      });
      expect(reactivated.status).toBe('ACTIVE');
    });

    it('allows the same user an active membership on a different domain', async () => {
      const first = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'First Org',
        slug: 'first-org',
        ownerEmail: 'multi-domain@example.com',
      });
      const elsewhere = await seedOrg({
        domain: VICTIM_DOMAIN,
        name: 'Other Domain Org',
        slug: 'other-domain-org',
        ownerEmail: 'other-domain-owner@example.com',
      });

      const created = await handle!.prisma.orgMember.create({
        data: { orgId: elsewhere.orgId, userId: first.ownerId, role: 'member' },
        select: { id: true },
      });
      expect(created.id).toBeTruthy();
    });
  });

  // ===================================================================
  // K1 — the named owner must belong to the calling domain.
  // ===================================================================
  describe('backend org create binds the named owner to the calling domain', () => {
    it('refuses an owner whose home domain is a different tenant', async () => {
      const foreignUser = await handle!.prisma.user.create({
        data: {
          email: 'foreign-owner@example.com',
          userKey: `${VICTIM_DOMAIN}:foreign-owner@example.com`,
          passwordHash: null,
          domain: VICTIM_DOMAIN,
        },
        select: { id: true },
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url('/org/organisations'),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { name: 'Poached Org', owner_user_id: foreignUser.id },
      });

      expect(res.statusCode).toBe(400);
      expect(
        await handle!.prisma.organisation.count({ where: { domain: ATTACKER_DOMAIN } }),
      ).toBe(0);
    });

    it('accepts an owner homed on the calling domain', async () => {
      const localUser = await handle!.prisma.user.create({
        data: {
          email: 'local-owner@example.com',
          userKey: `${ATTACKER_DOMAIN}:local-owner@example.com`,
          passwordHash: null,
          domain: ATTACKER_DOMAIN,
        },
        select: { id: true },
      });
      await handle!.prisma.domainRole.create({
        data: { domain: ATTACKER_DOMAIN, userId: localUser.id },
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url('/org/organisations'),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { name: 'Local Org', owner_user_id: localUser.id },
      });

      expect(res.statusCode).toBe(200);
      expect((res.json() as OrgRecord & { ownerId: string }).ownerId).toBe(localUser.id);
    });
  });

  // ===================================================================
  // Backend mode reached these routes through a mechanical
  // `if (!actorUserId)` pass with no test behind it. Each one is an
  // authority-bearing mutation, so each gets exercised as the domain backend.
  // ===================================================================
  describe('backend-mode coverage for authority-bearing routes', () => {
    async function backendApp() {
      await stubConfigs();
      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);
      return { app, headers: { authorization: `Bearer ${bearer}` } };
    }

    async function seedMember(orgId: string, teamId: string, email: string) {
      const user = await createTestUser(handle!, email);
      await handle!.prisma.orgMember.create({
        data: { orgId, userId: user.id, role: 'member' },
      });
      await handle!.prisma.teamMember.create({ data: { teamId, userId: user.id } });
      return user;
    }

    it('deletes an organisation and audits it with backend provenance', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Doomed Org',
        slug: 'doomed-org',
        ownerEmail: 'doomed-owner@example.com',
      });
      const { app, headers } = await backendApp();

      const res = await app.inject({
        method: 'DELETE',
        url: url(`/org/organisations/${org.orgId}`),
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(await handle!.prisma.organisation.count({ where: { id: org.orgId } })).toBe(0);

      const audit = await handle!.prisma.orgAuditLog.findFirst({
        where: { orgId: org.orgId, action: 'org.deleted' },
        select: { actorUserId: true, metadata: true },
      });
      expect(audit).not.toBeNull();
      expect(audit!.actorUserId).toBeNull();
      expect(
        (audit!.metadata as Record<string, unknown>)[ORG_AUDIT_ACTOR_METADATA_KEY],
      ).toEqual({ via: 'domain_backend', source_domain: ATTACKER_DOMAIN });
    });

    it('refuses to transfer ownership to someone who is not a member at all', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Transfer Org',
        slug: 'transfer-org',
        ownerEmail: 'transfer-owner@example.com',
      });
      const stranger = await createTestUser(handle!, 'stranger@example.com');
      const { app, headers } = await backendApp();

      const res = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${org.orgId}/transfer-ownership`),
        headers,
        payload: { newOwnerId: stranger.id },
      });

      expect(res.statusCode).toBe(404);
      const after = await handle!.prisma.organisation.findUniqueOrThrow({
        where: { id: org.orgId },
        select: { ownerId: true },
      });
      expect(after.ownerId).toBe(org.ownerId);
    });

    it('refuses to create an organisation for an owner that does not exist', async () => {
      const { app, headers } = await backendApp();

      const res = await app.inject({
        method: 'POST',
        url: url('/org/organisations'),
        headers,
        payload: { name: 'Ghost Org', owner_user_id: 'user_does_not_exist' },
      });

      expect(res.statusCode).toBe(400);
      expect(
        await handle!.prisma.organisation.count({ where: { domain: ATTACKER_DOMAIN } }),
      ).toBe(0);
    });

    it('deactivates and reactivates a member, auditing both', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Lifecycle Org',
        slug: 'lifecycle-org',
        ownerEmail: 'lifecycle-owner@example.com',
      });
      const member = await seedMember(org.orgId, org.teamId, 'lifecycle-member@example.com');
      const { app, headers } = await backendApp();

      const deactivated = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${org.orgId}/members/${member.id}/deactivate`),
        headers,
      });
      expect(deactivated.statusCode).toBe(200);
      expect(
        (
          await handle!.prisma.orgMember.findFirstOrThrow({
            where: { orgId: org.orgId, userId: member.id },
            select: { status: true },
          })
        ).status,
      ).toBe('DEACTIVATED');

      const reactivated = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${org.orgId}/members/${member.id}/reactivate`),
        headers,
      });
      expect(reactivated.statusCode).toBe(200);
      expect(
        (
          await handle!.prisma.orgMember.findFirstOrThrow({
            where: { orgId: org.orgId, userId: member.id },
            select: { status: true },
          })
        ).status,
      ).toBe('ACTIVE');

      const actions = await handle!.prisma.orgAuditLog.findMany({
        where: { orgId: org.orgId },
        select: { action: true, actorUserId: true },
      });
      expect(actions.map((row) => row.action).sort()).toEqual(
        expect.arrayContaining(['member.deactivated', 'member.reactivated']),
      );
      expect(actions.every((row) => row.actorUserId === null)).toBe(true);
    });

    it('removes a member and refuses to remove the last remaining owner', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Removal Org',
        slug: 'removal-org',
        ownerEmail: 'removal-owner@example.com',
      });
      const member = await seedMember(org.orgId, org.teamId, 'removal-member@example.com');
      const { app, headers } = await backendApp();

      const removed = await app.inject({
        method: 'DELETE',
        url: url(`/org/organisations/${org.orgId}/members/${member.id}`),
        headers,
      });
      expect(removed.statusCode).toBe(200);

      // The owner-count invariant is NOT an actor check, so it applies to the
      // backend exactly as it does to a user.
      const lastOwner = await app.inject({
        method: 'DELETE',
        url: url(`/org/organisations/${org.orgId}/members/${org.ownerId}`),
        headers,
      });
      expect(lastOwner.statusCode).toBe(400);
      expect(
        (
          await handle!.prisma.orgMember.findFirstOrThrow({
            where: { orgId: org.orgId, userId: org.ownerId },
            select: { status: true },
          })
        ).status,
      ).toBe('ACTIVE');
    });

    it('creates, lists and revokes a team invite link', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Invite Org',
        slug: 'invite-org',
        ownerEmail: 'invite-owner@example.com',
      });
      const { app, headers } = await backendApp();
      const base = `/org/organisations/${org.orgId}/teams/${org.teamId}/invite-links`;

      const created = await app.inject({
        method: 'POST',
        url: url(base),
        headers,
        payload: {},
      });
      expect(created.statusCode).toBe(200);
      // The one-time token is returned alongside the record and never again.
      const { token, link } = created.json() as { token: string; link: { id: string } };
      expect(token).toBeTruthy();
      expect(link.id).toBeTruthy();

      const listed = await app.inject({ method: 'GET', url: url(base), headers });
      expect(listed.statusCode).toBe(200);
      expect((listed.json() as { data: { id: string }[] }).data.map((row) => row.id)).toContain(
        link.id,
      );

      const revoked = await app.inject({
        method: 'DELETE',
        url: url(`${base}/${link.id}`),
        headers,
      });
      expect(revoked.statusCode).toBe(200);
    });
  });

  // ===================================================================
  // Brief 24.8 lists three org-level checks as DELIBERATELY dropped in
  // backend mode. "Deliberate" is only credible if the behaviour is pinned,
  // so each is asserted here rather than left to be inferred from the diff.
  // ===================================================================
  describe('checks the brief documents as dropped in backend mode', () => {
    it('lets the backend change a member role although it is not the owner', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Role Org',
        slug: 'role-org',
        ownerEmail: 'role-owner@example.com',
      });
      const member = await createTestUser(handle!, 'role-member@example.com');
      await handle!.prisma.orgMember.create({
        data: { orgId: org.orgId, userId: member.id, role: 'member' },
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'PUT',
        url: url(`/org/organisations/${org.orgId}/members/${member.id}`),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { role: 'admin' },
      });

      expect(res.statusCode).toBe(200);
      expect(
        (
          await handle!.prisma.orgMember.findFirstOrThrow({
            where: { orgId: org.orgId, userId: member.id },
            select: { role: true },
          })
        ).role,
      ).toBe('admin');
    });

    it('lets the backend create an organisation although allow_user_create_org is false', async () => {
      const owner = await createTestUser(handle!, 'gated-owner@example.com');
      await handle!.prisma.domainRole.create({
        data: { domain: ATTACKER_DOMAIN, userId: owner.id },
      });
      // The flag governs whether END USERS may self-serve a workspace; it says
      // nothing about the domain asking on its own behalf.
      await stubConfigs({ allowUserCreateOrg: false });

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url('/org/organisations'),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { name: 'Gated Org', owner_user_id: owner.id },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ===================================================================
  // C5 — ownership must not land on a tombstoned member.
  // ===================================================================
  describe('ownership transfer', () => {
    it('refuses to transfer ownership to a REMOVED member', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Transfer Org',
        slug: 'transfer-org',
        ownerEmail: 'transfer-owner@example.com',
      });
      const removed = await createTestUser(handle!, 'removed-member@example.com');
      await handle!.prisma.orgMember.create({
        data: {
          orgId: org.orgId,
          userId: removed.id,
          role: 'admin',
          status: 'REMOVED',
          statusChangedAt: new Date(),
        },
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${org.orgId}/transfer-ownership`),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { newOwnerId: removed.id },
      });

      expect(res.statusCode).toBe(404);
      const after = await handle!.prisma.organisation.findUniqueOrThrow({
        where: { id: org.orgId },
        select: { ownerId: true },
      });
      expect(after.ownerId).toBe(org.ownerId);
    });

    it('transfers ownership to an ACTIVE member and audits it', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Transfer Org',
        slug: 'transfer-org',
        ownerEmail: 'transfer-owner@example.com',
      });
      const successor = await createTestUser(handle!, 'successor@example.com');
      await handle!.prisma.orgMember.create({
        data: { orgId: org.orgId, userId: successor.id, role: 'admin' },
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${org.orgId}/transfer-ownership`),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { newOwnerId: successor.id },
      });

      expect(res.statusCode).toBe(200);
      const after = await handle!.prisma.organisation.findUniqueOrThrow({
        where: { id: org.orgId },
        select: { ownerId: true },
      });
      expect(after.ownerId).toBe(successor.id);

      const audit = await handle!.prisma.orgAuditLog.findFirst({
        where: { orgId: org.orgId, action: 'org.ownership_transferred' },
        select: { actorUserId: true, metadata: true },
      });
      expect(audit).not.toBeNull();
      expect(audit!.actorUserId).toBeNull();
      expect(
        (audit!.metadata as Record<string, { via: string; source_domain: string }>)[
          ORG_AUDIT_ACTOR_METADATA_KEY
        ],
      ).toEqual({ via: 'domain_backend', source_domain: ATTACKER_DOMAIN });
    });
  });
});
