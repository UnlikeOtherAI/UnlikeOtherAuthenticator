import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { activeBillingBlockers, orphanEligibility } from '../../src/services/entity-deletion-preview.service.js';
import { createTestDb } from '../helpers/test-db.js';

describe.skipIf(!process.env.DATABASE_URL)('deletion dependency refusal on PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const native = process.env.MCP_OAUTH_DOMAIN;
  const domain = 'eligibility.example.com';
  beforeAll(async () => {
    handle = (await createTestDb())!;
    process.env.MCP_OAUTH_DOMAIN = 'native-eligibility.example.com';
  });
  afterAll(async () => {
    if (native === undefined) delete process.env.MCP_OAUTH_DOMAIN; else process.env.MCP_OAUTH_DOMAIN = native;
    await handle?.cleanup();
  });
  async function subject() {
    const db = handle.prisma, suffix = randomUUID();
    const user = await db.user.create({ data: { email: `${suffix}@example.com`, userKey: suffix } });
    const org = await db.organisation.create({ data: { domain, name: 'Candidate', slug: suffix, ownerId: user.id } });
    const team = await db.team.create({ data: { orgId: org.id, name: 'Included', slug: 'included' } });
    await db.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await db.teamMember.create({ data: { teamId: team.id, userId: user.id } });
    const read = (committed = false) => orphanEligibility(db, user.id, org.id, [team.id], true, committed);
    return { db, user, org, team, read };
  }

  it('admits only the eligible lifecycle, including the already committed deleting subject', async () => {
    const f = await subject();
    expect(await f.read()).toMatchObject({ eligible: true, reasons: [] });
    await f.db.user.update({ where: { id: f.user.id }, data: { lifecycleStatus: 'DELETING' } });
    expect((await f.read()).reasons).toEqual(['Account already has a terminal lifecycle']);
    expect(await f.read(true)).toMatchObject({ eligible: true, reasons: [] });
    await f.db.user.update({ where: { id: f.user.id }, data: { lifecycleStatus: 'DELETED' } });
    expect((await f.read(true)).reasons).toEqual(['Account already has a terminal lifecycle']);
    expect((await orphanEligibility(f.db, randomUUID(), f.org.id, [f.team.id], true)).reasons)
      .toEqual(['Account already has a terminal lifecycle']);
  });

  it('preserves other-team, other-organisation and ownership refusals', async () => {
    const f = await subject();
    const other = await f.db.organisation.create({ data: { domain, name: 'Outside', slug: randomUUID(), ownerId: f.user.id } });
    const team = await f.db.team.create({ data: { orgId: other.id, name: 'Outside', slug: 'outside' } });
    await f.db.orgMember.create({ data: { orgId: other.id, userId: f.user.id } });
    await f.db.teamMember.create({ data: { teamId: team.id, userId: f.user.id } });
    expect((await f.read()).reasons).toEqual(['Other team membership', 'Other organisation membership', 'Organisation ownership']);
  });

  it('keeps native/platform roles and unrelated product identity outside orphan deletion', async () => {
    const f = await subject();
    await f.db.domainRole.createMany({ data: [
      { userId: f.user.id, domain: process.env.MCP_OAUTH_DOMAIN!, role: 'USER' },
      { userId: f.user.id, domain: getAdminAuthDomain(), role: 'SUPERUSER' },
    ] });
    expect((await f.read()).reasons).toEqual(['Standalone native account', 'Platform administrator', 'Other product identity association']);
  });

  it('retains settings, standalone sessions and other-product authentication history', async () => {
    const f = await subject();
    await f.db.userSetting.create({ data: { userId: f.user.id, namespace: 'personal', key: 'saved', value: [], sizeBytes: 2 } });
    await f.db.refreshToken.create({ data: { userId: f.user.id, domain, clientId: 'stable-test-reference', configUrl: `https://${domain}/config`,
      familyId: randomUUID(), tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    await f.db.loginLog.create({ data: { userId: f.user.id, email: f.user.email!, domain: 'other.example.com', authMethod: 'password' } });
    expect((await f.read()).reasons).toEqual(['Personal settings', 'Standalone or other product session history', 'Other product authentication history']);
  });

  it('distinguishes live financial responsibility from protected inactive history', async () => {
    const f = await subject();
    const row = await f.db.billingOrgResponsibility.create({ data: { orgId: f.org.id, assumedAt: new Date(), assumedByUserId: f.user.id } });
    const message = 'Close or transfer active BillingOrgResponsibility operations before deletion.';
    expect(await activeBillingBlockers(f.db, 'ORGANISATION', f.org.id)).toContain(message);
    expect(await activeBillingBlockers(f.db, 'USER', f.user.id)).toContain(message);
    await f.db.billingOrgResponsibility.update({ where: { id: row.id }, data: { active: false } });
    expect(await activeBillingBlockers(f.db, 'ORGANISATION', f.org.id)).not.toContain(message);
    expect((await f.read()).reasons).toEqual(['Protected billing or signing dependencies']);
  });
});
