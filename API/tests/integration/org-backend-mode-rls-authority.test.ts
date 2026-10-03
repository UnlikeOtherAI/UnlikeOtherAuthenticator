// Exercise tenant boundaries with the production uoa_app/uoa_admin RLS roles.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { ORG_AUDIT_ACTOR_METADATA_KEY } from '../../src/services/org-audit-log.service.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { createTestUser, hasDatabase } from '../helpers/org-user-endpoints-helper.js';
import { ATTACKER_DOMAIN, useBackendRlsFixture } from '../helpers/backend-rls-fixture.js';

describe.skipIf(!hasDatabase)('/org/* under production RLS roles (uoa_app)', () => {
  const { state, stubConfigs, url, seedOrg } = useBackendRlsFixture();
  describe('backend-mode coverage for authority-bearing routes', () => {
    async function backendApp() {
      await stubConfigs();
      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);
      return { app, headers: { authorization: `Bearer ${bearer}` } };
    }

    async function seedMember(orgId: string, teamId: string, email: string) {
      const user = await createTestUser(state.handle!, email);
      await state.handle!.prisma.orgMember.create({
        data: { orgId, userId: user.id, role: 'member' },
      });
      await state.handle!.prisma.teamMember.create({ data: { teamId, userId: user.id } });
      return user;
    }

    it('refuses backend deletion without removing or auditing the organisation', async () => {
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

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'ENTITY_DELETION_WORKFLOW_REQUIRED' });
      expect(await state.handle!.prisma.organisation.count({ where: { id: org.orgId } })).toBe(1);

      const audit = await state.handle!.prisma.orgAuditLog.findFirst({
        where: { orgId: org.orgId, action: 'org.deleted' },
        select: { actorUserId: true, metadata: true },
      });
      expect(audit).toBeNull();
      await app.close();
    });

    it('refuses to transfer ownership to someone who is not a member at all', async () => {
      const org = await seedOrg({
        domain: ATTACKER_DOMAIN,
        name: 'Transfer Org',
        slug: 'transfer-org',
        ownerEmail: 'transfer-owner@example.com',
      });
      const stranger = await createTestUser(state.handle!, 'stranger@example.com');
      const { app, headers } = await backendApp();

      const res = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${org.orgId}/transfer-ownership`),
        headers,
        payload: { newOwnerId: stranger.id },
      });

      expect(res.statusCode).toBe(404);
      const after = await state.handle!.prisma.organisation.findUniqueOrThrow({
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
        await state.handle!.prisma.organisation.count({ where: { domain: ATTACKER_DOMAIN } }),
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
          await state.handle!.prisma.orgMember.findFirstOrThrow({
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
          await state.handle!.prisma.orgMember.findFirstOrThrow({
            where: { orgId: org.orgId, userId: member.id },
            select: { status: true },
          })
        ).status,
      ).toBe('ACTIVE');

      const actions = await state.handle!.prisma.orgAuditLog.findMany({
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
          await state.handle!.prisma.orgMember.findFirstOrThrow({
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
      const member = await createTestUser(state.handle!, 'role-member@example.com');
      await state.handle!.prisma.orgMember.create({
        data: { orgId: org.orgId, userId: member.id, role: 'member' },
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'PUT',
        url: url(`/org/organisations/${org.orgId}/members/${member.id}`),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { role: 'admin' },
      });

      expect(res.statusCode).toBe(200);
      expect(
        (
          await state.handle!.prisma.orgMember.findFirstOrThrow({
            where: { orgId: org.orgId, userId: member.id },
            select: { role: true },
          })
        ).role,
      ).toBe('admin');
    });

    it('lets the backend create an organisation although allow_user_create_org is false', async () => {
      const owner = await createTestUser(state.handle!, 'gated-owner@example.com');
      await state.handle!.prisma.domainRole.create({
        data: { domain: ATTACKER_DOMAIN, userId: owner.id },
      });
      // The flag governs whether END USERS may self-serve a team; it says
      // nothing about the domain asking on its own behalf.
      await stubConfigs({ allowUserCreateOrg: false });

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

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
      const removed = await createTestUser(state.handle!, 'removed-member@example.com');
      await state.handle!.prisma.orgMember.create({
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
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${org.orgId}/transfer-ownership`),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { newOwnerId: removed.id },
      });

      expect(res.statusCode).toBe(404);
      const after = await state.handle!.prisma.organisation.findUniqueOrThrow({
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
      const successor = await createTestUser(state.handle!, 'successor@example.com');
      await state.handle!.prisma.orgMember.create({
        data: { orgId: org.orgId, userId: successor.id, role: 'admin' },
      });
      await stubConfigs();

      const app = await createApp();
      await app.ready();
      const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);

      const res = await app.inject({
        method: 'POST',
        url: url(`/org/organisations/${org.orgId}/transfer-ownership`),
        headers: { authorization: `Bearer ${bearer}` },
        payload: { newOwnerId: successor.id },
      });

      expect(res.statusCode).toBe(200);
      const after = await state.handle!.prisma.organisation.findUniqueOrThrow({
        where: { id: org.orgId },
        select: { ownerId: true },
      });
      expect(after.ownerId).toBe(successor.id);

      const audit = await state.handle!.prisma.orgAuditLog.findFirst({
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
