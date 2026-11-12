import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { ATTACKER_DOMAIN, VICTIM_DOMAIN, useBackendRlsFixture } from '../helpers/backend-rls-fixture.js';
import { createTestUser, hasDatabase, signAccessToken } from '../helpers/org-user-endpoints-helper.js';

describe.skipIf(!hasDatabase)('organisation creation recovery under production RLS', () => {
  const { state, stubConfigs, url, seedOrg } = useBackendRlsFixture();
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

  async function fixture() {
    await stubConfigs({ allowUserCreateOrg: true });
    const owner = await createTestUser(state.handle!, `${randomUUID()}@example.com`);
    await state.handle!.prisma.domainRole.create({ data: { domain: ATTACKER_DOMAIN, userId: owner.id } });
    const bearer = await seedDomainSecret(state.handle!.prisma, ATTACKER_DOMAIN);
    const app = await createApp();
    apps.push(app);
    await app.ready();
    const headers = { authorization: `Bearer ${bearer}`, 'idempotency-key': randomUUID() };
    const contract = await app.inject({ method: 'GET', url: url('/org/creation-contract'), headers });
    expect(contract.statusCode).toBe(200);
    expect(contract.json()).toMatchObject({ capability: 'org_creation_recovery_v1', version: 1 });
    return { app, owner, headers: { ...headers, 'x-uoa-creation-registration': contract.json().registrationId as string } };
  }

  it('recovers a discarded response in a new app and replays current fields without another creation', async () => {
    const { app, owner, headers } = await fixture();
    const payload = { name: 'Recover One', owner_user_id: owner.id };
    // The client loses this response. Recovery below uses only the durable key.
    const first = await app.inject({ method: 'POST', url: url('/org/organisations'), headers, payload });
    expect(first.statusCode).toBe(200);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = await createApp();
    apps.push(restarted);
    await restarted.ready();
    const recovered = await restarted.inject({ method: 'GET', url: url('/org/organisations/creation-status'), headers });
    expect(recovered.statusCode).toBe(200);
    const ids = recovered.json();
    expect(ids).toEqual({ status: 'committed', organisationId: first.json().id, teamId: first.json().defaultTeam.id });
    expect(recovered.headers['cache-control']).toBe('private, no-store');
    await state.handle!.prisma.organisation.update({ where: { id: ids.organisationId }, data: { name: 'Renamed' } });
    const replay = await restarted.inject({ method: 'POST', url: url('/org/organisations'), headers, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: ids.organisationId, name: 'Renamed', defaultTeam: { id: ids.teamId } });
    expect(await state.handle!.prisma.organisation.count({ where: { ownerId: owner.id } })).toBe(1);
    expect(await state.handle!.prisma.orgAuditLog.count({ where: { orgId: ids.organisationId, action: 'org.created' } })).toBe(1);
  });

  it('serializes concurrent duplicates and rejects changed effective input', async () => {
    const { app, owner, headers } = await fixture();
    const request = { method: 'POST' as const, url: url('/org/organisations'), headers,
      payload: { name: 'Concurrent One', owner_user_id: owner.id } };
    const results = await Promise.all([app.inject(request), app.inject(request), app.inject(request)]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(results.map(result => result.json().id)).size).toBe(1);
    expect(new Set(results.map(result => result.json().defaultTeam.id)).size).toBe(1);
    const conflict = await app.inject({ ...request, payload: { ...request.payload, name: 'Different' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.payload).toContain('CREATION_KEY_CONFLICT');
    expect(await state.handle!.prisma.organisation.count({ where: { ownerId: owner.id } })).toBe(1);
    expect(await state.handle!.prisma.orgAuditLog.count({ where: { orgId: results[0].json().id } })).toBe(1);
  });

  it('rolls back resource, memberships and audit when receipt publication fails, then recovers normally', async () => {
    const { app, owner, headers } = await fixture();
    await state.handle!.prisma.$executeRawUnsafe(`CREATE FUNCTION reject_creation_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture receipt failure'; END; $$`);
    await state.handle!.prisma.$executeRawUnsafe(`CREATE TRIGGER fixture_receipt_failure
      BEFORE INSERT ON org_creation_operations FOR EACH ROW EXECUTE FUNCTION reject_creation_receipt()`);
    const request = { method: 'POST' as const, url: url('/org/organisations'), headers,
      payload: { name: 'Rollback One', owner_user_id: owner.id } };
    try {
      expect((await app.inject(request)).statusCode).toBe(500);
      expect(await state.handle!.prisma.organisation.count({ where: { ownerId: owner.id } })).toBe(0);
      expect(await state.handle!.prisma.orgMember.count({ where: { userId: owner.id } })).toBe(0);
      expect(await state.handle!.prisma.teamMember.count({ where: { userId: owner.id } })).toBe(0);
      expect(await state.handle!.prisma.orgAuditLog.count()).toBe(0);
      const status = await app.inject({ method: 'GET', url: url('/org/organisations/creation-status'), headers });
      expect(status.statusCode).toBe(404);
      expect(status.payload).toContain('CREATION_OPERATION_NOT_FOUND');
    } finally {
      await state.handle!.prisma.$executeRawUnsafe('DROP TRIGGER fixture_receipt_failure ON org_creation_operations');
      await state.handle!.prisma.$executeRawUnsafe('DROP FUNCTION reject_creation_receipt()');
    }
    expect((await app.inject(request)).statusCode).toBe(200);
  });

  it('does not publish a result when its atomic audit fails', async () => {
    const { app, owner, headers } = await fixture();
    await state.handle!.prisma.$executeRawUnsafe(`CREATE FUNCTION reject_creation_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END; $$`);
    await state.handle!.prisma.$executeRawUnsafe(`CREATE TRIGGER fixture_creation_audit_failure
      BEFORE INSERT ON org_audit_log FOR EACH ROW EXECUTE FUNCTION reject_creation_audit()`);
    try {
      const result = await app.inject({ method: 'POST', url: url('/org/organisations'), headers,
        payload: { name: 'Audit Rollback', owner_user_id: owner.id } });
      expect(result.statusCode).toBe(500);
      expect(await state.handle!.prisma.organisation.count({ where: { ownerId: owner.id } })).toBe(0);
      expect((await app.inject({ method: 'GET', url: url('/org/organisations/creation-status'), headers })).payload)
        .toContain('CREATION_OPERATION_NOT_FOUND');
    } finally {
      await state.handle!.prisma.$executeRawUnsafe('DROP TRIGGER fixture_creation_audit_failure ON org_audit_log');
      await state.handle!.prisma.$executeRawUnsafe('DROP FUNCTION reject_creation_audit()');
    }
  });

  it('binds recovery to the original user and registered domain, separate from backend mode', async () => {
    const { app, owner, headers } = await fixture();
    const token = await signAccessToken({ subject: owner.id, domain: ATTACKER_DOMAIN,
      secret: process.env.SHARED_SECRET!, issuer: process.env.AUTH_SERVICE_IDENTIFIER! });
    const humanHeaders = { ...headers, 'x-uoa-access-token': token };
    const created = await app.inject({ method: 'POST', url: url('/org/organisations'), headers: humanHeaders,
      payload: { name: 'Human One' } });
    expect(created.statusCode).toBe(200);
    const other = await createTestUser(state.handle!, `${randomUUID()}@example.com`);
    await state.handle!.prisma.domainRole.create({ data: { domain: ATTACKER_DOMAIN, userId: other.id } });
    const otherToken = await signAccessToken({ subject: other.id, domain: ATTACKER_DOMAIN,
      secret: process.env.SHARED_SECRET!, issuer: process.env.AUTH_SERVICE_IDENTIFIER! });
    for (const candidate of [headers, { ...headers, 'x-uoa-access-token': otherToken }]) {
      const response = await app.inject({ method: 'GET', url: url('/org/organisations/creation-status'), headers: candidate });
      expect(response.statusCode).toBe(404);
      expect(response.payload).not.toContain(created.json().id);
    }
    const otherBearer = await seedDomainSecret(state.handle!.prisma, VICTIM_DOMAIN);
    const wrongDomain = await app.inject({ method: 'GET', url: url('/org/organisations/creation-status', VICTIM_DOMAIN),
      headers: { ...headers, authorization: `Bearer ${otherBearer}` } });
    expect(wrongDomain.statusCode).toBe(409);
    expect(wrongDomain.payload).toContain('CREATION_REGISTRATION_CHANGED');
    const own = await app.inject({ method: 'GET', url: url('/org/organisations/creation-status'), headers: humanHeaders });
    expect(own.statusCode).toBe(200);
    await state.handle!.prisma.orgMember.update({ where: { orgId_userId: { orgId: created.json().id, userId: owner.id } },
      data: { status: 'REMOVED' } });
    const revoked = await app.inject({ method: 'GET', url: url('/org/organisations/creation-status'), headers: humanHeaders });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.payload).not.toContain(created.json().id);
  });

  it('keeps a team key scoped to its parent and never recreates a deleted result', async () => {
    const { app, headers } = await fixture();
    const parent = await seedOrg({ domain: ATTACKER_DOMAIN, name: 'Parent', slug: 'parent', ownerEmail: 'parent@example.com' });
    const sibling = await seedOrg({ domain: ATTACKER_DOMAIN, name: 'Sibling', slug: 'sibling', ownerEmail: 'sibling@example.com' });
    const request = { method: 'POST' as const, url: url(`/org/organisations/${parent.orgId}/teams`), headers,
      payload: { name: 'Engineering', description: ' Team ' } };
    const [first, second] = await Promise.all([app.inject(request), app.inject(request)]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(first.json().id).toBe(second.json().id);
    const wrongParent = await app.inject({ method: 'GET', headers,
      url: url(`/org/organisations/${sibling.orgId}/teams/creation-status`) });
    expect(wrongParent.statusCode).toBe(404);
    const statusUrl = url(`/org/organisations/${parent.orgId}/teams/creation-status`);
    expect((await app.inject({ method: 'GET', headers, url: statusUrl })).json()).toMatchObject({ teamId: first.json().id });
    await state.handle!.prisma.team.delete({ where: { id: first.json().id } });
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(404);
    expect(replay.payload).toContain('CREATION_RESULT_UNAVAILABLE');
    expect(await state.handle!.prisma.team.count({ where: { orgId: parent.orgId } })).toBe(1);
    const receipt = await state.handle!.prisma.orgCreationOperation.findFirstOrThrow({ where: { resultTeamId: first.json().id } });
    await expect(state.handle!.prisma.orgCreationOperation.delete({ where: { id: receipt.id } })).rejects.toThrow();
    await expect(state.handle!.prisma.orgCreationOperation.update({ where: { id: receipt.id },
      data: { requestHash: 'f'.repeat(64) } })).rejects.toThrow();
  });

  it('publishes discovery, rejects malformed keys and keeps ordinary authentication mandatory', async () => {
    const { app, owner, headers } = await fixture();
    expect((await app.inject('/api')).json().org_creation_recovery).toMatchObject({ capability: 'org_creation_recovery_v1', version: 1 });
    const malformed = await app.inject({ method: 'POST', url: url('/org/organisations'),
      headers: { ...headers, 'idempotency-key': '' }, payload: { name: 'Invalid', owner_user_id: owner.id } });
    expect(malformed.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: url('/org/organisations/creation-status'),
      headers: { 'idempotency-key': headers['idempotency-key'] } })).statusCode).toBe(401);
    expect(await state.handle!.prisma.organisation.count({ where: { ownerId: owner.id } })).toBe(0);
  });

  it('refuses an old registration on reads and writes without creating another resource', async () => {
    const { app, owner, headers } = await fixture();
    const original = { method: 'POST' as const, url: url('/org/organisations'), headers,
      payload: { name: 'Registration Bound', owner_user_id: owner.id } };
    expect((await app.inject(original)).statusCode).toBe(200);
    for (const registration of [randomUUID(), '']) {
      const changed = { ...headers, 'x-uoa-creation-registration': registration };
      const post = await app.inject({ ...original, headers: changed });
      const lookup = await app.inject({ method: 'GET', url: url('/org/organisations/creation-status'), headers: changed });
      for (const result of [post, lookup]) {
        expect(result.statusCode).toBe(409);
        expect(result.payload).toContain('CREATION_REGISTRATION_CHANGED');
      }
    }
    expect(await state.handle!.prisma.organisation.count({ where: { ownerId: owner.id } })).toBe(1);
  });
});
