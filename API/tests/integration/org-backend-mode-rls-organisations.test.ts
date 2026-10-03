// Exercise tenant boundaries with the production uoa_app/uoa_admin RLS roles.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { hasDatabase, type OrgListRecord, type OrgRecord } from '../helpers/org-user-endpoints-helper.js';
import { ATTACKER_DOMAIN, VICTIM_DOMAIN, useBackendRlsFixture } from '../helpers/backend-rls-fixture.js';

describe.skipIf(!hasDatabase)('/org/* under production RLS roles (uoa_app)', () => {
  const { state, stubConfigs, url, seedOrg } = useBackendRlsFixture();
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
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

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
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url('/org/organisations'),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { name: 'Second Org', owner_user_id: first.ownerId },
      });

      expect(res.statusCode).toBe(200);
      const orgCount = await state.handle!.prisma.organisation.count({
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
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${second.orgId}/members`),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { userId: first.ownerId, role: 'member' },
      });

      expect(res.statusCode).toBe(200);
      const memberships = await state.handle!.prisma.orgMember.count({
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
      const membership = await state.handle!.prisma.orgMember.create({
        data: { orgId: second.orgId, userId: first.ownerId, role: 'member' },
      });
      expect(membership.id).toBeTruthy();

      expect(
        await state.handle!.prisma.orgMember.count({
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
      const removed = await state.handle!.prisma.orgMember.create({
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

      const reactivated = await state.handle!.prisma.orgMember.update({
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

      const created = await state.handle!.prisma.orgMember.create({
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
      const foreignUser = await state.handle!.prisma.user.create({
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
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url('/org/organisations'),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { name: 'Poached Org', owner_user_id: foreignUser.id },
      });

      expect(res.statusCode).toBe(400);
      expect(
        await state.handle!.prisma.organisation.count({ where: { domain: ATTACKER_DOMAIN } }),
      ).toBe(0);
    });

    it('accepts an owner homed on the calling domain', async () => {
      const localUser = await state.handle!.prisma.user.create({
        data: {
          email: 'local-owner@example.com',
          userKey: `${ATTACKER_DOMAIN}:local-owner@example.com`,
          passwordHash: null,
          domain: ATTACKER_DOMAIN,
        },
        select: { id: true },
      });
      await state.handle!.prisma.domainRole.create({
        data: { domain: ATTACKER_DOMAIN, userId: localUser.id },
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

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

});
