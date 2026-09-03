// The RLS policies themselves, asserted directly.
//
// `org-backend-mode-rls.test.ts` drives real routes, which is the right test for
// "does the product hold together" — but it is NOT a test of the policies. Every
// route-level case there passes with the domain half of the policy predicate
// deleted, because an earlier layer refuses the call first — the strict
// `resolveOrganisationByDomain` for access requests, and `acceptDomainBackendCaller`
// for backend mode. Three mutants survived that whole suite:
//
//   M1  delete `AND uoa_org_in_domain(org_id, app.domain)` from all four
//       access_requests policies — the "two independent layers" claim asserted
//       in the migration header but never verified.
//   M4  delete the `owner_user_id` → `DomainRole` binding in
//       organisation.service.organisation.ts.
//   M5  delete the `app.domain_backend = 'on'` gate from organisations_select —
//       which would hand the domain-wide branch to EVERY signed-in user.
//
// The two policy mutants (M1, M5) are killed here by setting the GUCs and
// reading, with no service layer in front. M4 is killed in org-backend-mode.ts
// where the route lives.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';

import { runWithTenantContext } from '../../src/db/tenant-context.js';
import { createRlsTestDb } from '../helpers/test-db.js';
import { createTestUser, hasDatabase } from '../helpers/org-user-endpoints-helper.js';

const DOMAIN_A = 'policy-a.example.com';
const DOMAIN_B = 'policy-b.example.com';

describe.skipIf(!hasDatabase)('/org/* RLS policy predicates (as uoa_app)', () => {
  let handle: Awaited<ReturnType<typeof createRlsTestDb>>;
  let appPrisma: PrismaClient;

  beforeAll(async () => {
    handle = await createRlsTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    // The non-BYPASSRLS runtime role. Seeding still uses `handle.prisma`
    // (superuser), so the fixtures exist regardless of what the policies allow.
    appPrisma = new PrismaClient({ datasources: { db: { url: handle.appDatabaseUrl } } });
    await appPrisma.$connect();
  });

  afterAll(async () => {
    await appPrisma?.$disconnect();
    if (handle) await handle.cleanup();
  });

  type Seeded = { orgId: string; teamId: string; ownerId: string; accessRequestId: string };

  async function seedOrg(domain: string, slug: string, email: string): Promise<Seeded> {
    const owner = await createTestUser(handle!, email);
    const org = await handle!.prisma.organisation.create({
      data: { domain, name: slug, slug, ownerId: owner.id },
      select: { id: true },
    });
    const team = await handle!.prisma.team.create({
      data: { orgId: org.id, name: 'General', slug: 'general', isDefault: true },
      select: { id: true },
    });
    await handle!.prisma.orgMember.create({
      data: { orgId: org.id, userId: owner.id, role: 'owner' },
    });
    const accessRequest = await handle!.prisma.accessRequest.create({
      data: {
        orgId: org.id,
        teamId: team.id,
        email: `applicant-${slug}@example.com`,
        requestName: `Applicant ${slug}`,
        status: 'PENDING',
        lastRequestedAt: new Date(),
      },
      select: { id: true },
    });
    return { orgId: org.id, teamId: team.id, ownerId: owner.id, accessRequestId: accessRequest.id };
  }

  let a: Seeded;
  let b: Seeded;

  beforeEach(async () => {
    if (!handle) return;
    await handle.prisma.accessRequest.deleteMany();
    await handle.prisma.teamMember.deleteMany();
    await handle.prisma.team.deleteMany();
    await handle.prisma.orgMember.deleteMany();
    await handle.prisma.organisation.deleteMany();
    await handle.prisma.domainRole.deleteMany();
    await handle.prisma.user.deleteMany();

    a = await seedOrg(DOMAIN_A, 'alpha-co', 'alpha-owner@example.com');
    b = await seedOrg(DOMAIN_B, 'beta-co', 'beta-owner@example.com');
  });

  /** Read as `uoa_app` with exactly these GUCs — no routes, no services. */
  async function readAs<T>(
    context: { domain: string; orgId?: string | null; userId?: string | null; domainBackend?: boolean },
    read: (tx: Parameters<Parameters<typeof runWithTenantContext>[1]>[0]) => Promise<T>,
  ): Promise<T> {
    return runWithTenantContext({ prisma: appPrisma, context }, read);
  }

  // ===================================================================
  // M1 — the access_requests policies must key on the DOMAIN, not just on
  //      whatever `app.org_id` was set to.
  // ===================================================================
  describe('access_requests policies are domain-bound (kills M1)', () => {
    // The escape the domain half exists to close: `app.org_id` is populated from
    // the raw path `:orgId`, so a caller that names another tenant's org id gets
    // an `app.org_id` that the org-id half of the predicate happily matches. Only
    // the domain half refuses. If `AND uoa_org_in_domain(...)` is deleted, this
    // read returns the victim's access request.
    it('returns nothing when app.org_id names an org on another domain', async () => {
      const rows = await readAs({ domain: DOMAIN_A, orgId: b.orgId }, (tx) =>
        tx.accessRequest.findMany({ select: { id: true } }),
      );

      expect(rows).toEqual([]);
    });

    it('returns the row when the org and the domain agree', async () => {
      const rows = await readAs({ domain: DOMAIN_A, orgId: a.orgId }, (tx) =>
        tx.accessRequest.findMany({ select: { id: true } }),
      );

      expect(rows.map((row) => row.id)).toEqual([a.accessRequestId]);
    });

    // The write side carries the same predicate, and a WITH CHECK that only
    // looked at `app.org_id` would let a caller PLANT a row in another tenant.
    it('refuses to insert into an org on another domain', async () => {
      await expect(
        readAs({ domain: DOMAIN_A, orgId: b.orgId }, (tx) =>
          tx.accessRequest.create({
            data: {
              orgId: b.orgId,
              teamId: b.teamId,
              email: 'planted@example.com',
              requestName: 'Planted',
              status: 'PENDING',
              lastRequestedAt: new Date(),
            },
          }),
        ),
      ).rejects.toThrow();

      const planted = await handle!.prisma.accessRequest.count({
        where: { email: 'planted@example.com' },
      });
      expect(planted).toBe(0);
    });

    it('refuses to update a row in an org on another domain', async () => {
      const updated = await readAs({ domain: DOMAIN_A, orgId: b.orgId }, (tx) =>
        tx.accessRequest.updateMany({ where: {}, data: { status: 'APPROVED' } }),
      );

      expect(updated.count).toBe(0);
      const victim = await handle!.prisma.accessRequest.findUniqueOrThrow({
        where: { id: b.accessRequestId },
        select: { status: true },
      });
      expect(victim.status).toBe('PENDING');
    });

    it('refuses to delete a row in an org on another domain', async () => {
      const deleted = await readAs({ domain: DOMAIN_A, orgId: b.orgId }, (tx) =>
        tx.accessRequest.deleteMany({ where: {} }),
      );

      expect(deleted.count).toBe(0);
      expect(
        await handle!.prisma.accessRequest.count({ where: { id: b.accessRequestId } }),
      ).toBe(1);
    });
  });

  // ===================================================================
  // M5 — the domain-wide branch of organisations_select must stay gated on
  //      app.domain_backend.
  // ===================================================================
  describe('organisations_select domain branch is backend-gated (kills M5)', () => {
    // THE regression this gate prevents. Without it the branch collapses to
    // `domain = app.domain`, which every signed-in user's transaction satisfies:
    // a member of one team would suddenly see every organisation on the
    // domain. `app.domain_backend` is unset in user mode, so the branch is
    // unreachable there — and this is the only test that would notice if the
    // gate were removed.
    it('shows a user nothing on their own domain when they are in no org', async () => {
      const outsider = await createTestUser(handle!, 'outsider@example.com');

      const rows = await readAs({ domain: DOMAIN_A, userId: outsider.id }, (tx) =>
        tx.organisation.findMany({ select: { id: true } }),
      );

      expect(rows).toEqual([]);
    });

    it('shows a member only their own organisation, not the domain', async () => {
      const second = await seedOrg(DOMAIN_A, 'alpha-two', 'alpha-two-owner@example.com');

      const rows = await readAs({ domain: DOMAIN_A, userId: a.ownerId }, (tx) =>
        tx.organisation.findMany({ select: { id: true } }),
      );

      expect(rows.map((row) => row.id)).toEqual([a.orgId]);
      expect(rows.map((row) => row.id)).not.toContain(second.orgId);
    });

    // The counterpart: with the flag on, the whole domain IS visible — so the
    // test above is failing for the right reason (the gate), not because the
    // branch never matches anything.
    it('shows the whole domain — and only that domain — to the domain backend', async () => {
      const second = await seedOrg(DOMAIN_A, 'alpha-two', 'alpha-two-owner@example.com');

      const rows = await readAs({ domain: DOMAIN_A, domainBackend: true }, (tx) =>
        tx.organisation.findMany({ select: { id: true } }),
      );

      expect(rows.map((row) => row.id).sort()).toEqual([a.orgId, second.orgId].sort());
      expect(rows.map((row) => row.id)).not.toContain(b.orgId);
    });

    // org_members_select carries the same gate, for the same reason.
    it('hides sibling-org membership from a user and shows it to the backend', async () => {
      const second = await seedOrg(DOMAIN_A, 'alpha-two', 'alpha-two-owner@example.com');

      const asUser = await readAs({ domain: DOMAIN_A, userId: a.ownerId }, (tx) =>
        tx.orgMember.findMany({ where: { orgId: second.orgId }, select: { id: true } }),
      );
      expect(asUser).toEqual([]);

      const asBackend = await readAs({ domain: DOMAIN_A, domainBackend: true }, (tx) =>
        tx.orgMember.findMany({ where: { orgId: second.orgId }, select: { id: true } }),
      );
      expect(asBackend).toHaveLength(1);
    });
  });
});
