import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedDomainSecret } from '../helpers/domain-secret.js';
import { withChosenOrganisationSlug } from '../../src/services/organisation-slug-admission.service.js';
import { checkOrgSlugAvailability, resolveOrgById, resolveOrgHostname,
  resolveTeamById, resolveTeamHostname } from '../../src/services/team-hostname.service.js';

describe('registered product hostname namespace with PostgreSQL', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const saved = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL };
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL is required for product address coverage');
    handle = db;
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.DATABASE_ADMIN_URL = db.databaseUrl;
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await handle?.cleanup();
  });

  async function fixture() {
    const db = handle.prisma;
    const domain = `product-${randomUUID()}.example.com`;
    const bearer = await seedDomainSecret(db, domain);
    const service = await db.billingService.create({ data: { identifier: randomUUID(), name: 'Address test' } });
    const key = await db.billingAppKey.create({ data: {
      serviceId: service.id, purpose: 'CUSTOMER_LIFECYCLE', name: 'Address test',
      keyPrefix: randomUUID().slice(0, 8), secretDigest: createHash('sha256').update(randomUUID()).digest('hex'),
      actorIssuer: `https://${domain}`, actorAudience: 'https://auth.example.com/billing',
      actorKeyId: 'test', actorPublicJwk: {}, checkoutReturnOrigins: [`https://${domain}`],
    } });
    const owner = await db.user.create({ data: { email: `${randomUUID()}@example.com`, userKey: randomUUID() } });
    const org = await db.organisation.create({ data: {
      domain: `founder-${randomUUID()}.example.com`, ownerId: owner.id,
      name: 'Existing organisation', slug: `org-${randomUUID()}`,
    } });
    const team = await db.team.create({ data: { orgId: org.id, name: 'Existing team', slug: 'general' } });
    return { domain, bearer, key, org, team, owner, deps: { prisma: db } };
  }

  it('resolves an existing cross-product team in both directions through authenticated HTTP', async () => {
    const f = await fixture();
    const app = await createApp();
    const read = (path: string, bearer = f.bearer) => app.inject({ method: 'GET',
      url: `${path}${path.includes('?') ? '&' : '?'}domain=${f.domain}`,
      headers: { authorization: `Bearer ${bearer}` } });
    try {
      const address = await read(`/domain/teams/${f.team.id}/address`);
      expect(address.statusCode).toBe(200);
      expect(address.json()).toMatchObject({ org_id: f.org.id, team_id: f.team.id,
        org_slug: f.org.slug, team_slug: f.team.slug });
      const host = await read(`/domain/teams/resolve?org=${f.org.slug}&team=${f.team.slug}`);
      expect(host.statusCode).toBe(200);
      expect(host.json()).toMatchObject(address.json());
      const portal = await read(`/domain/organisations/resolve?org=${f.org.slug}`);
      expect(portal.statusCode).toBe(200);
      expect(portal.json()).toMatchObject({ org_id: f.org.id, org_slug: f.org.slug });
      expect(portal.json()).not.toHaveProperty('team_id');
      expect((await read(`/domain/teams/${f.team.id}/address`, 'invalid')).statusCode).toBe(401);
      expect(await checkOrgSlugAvailability({ domain: f.domain, slug: f.org.slug }, f.deps))
        .toEqual({ available: false, reason: 'taken' });
    } finally { await app.close(); }
  });

  it('retains domain isolation after the registered product mapping is revoked', async () => {
    const f = await fixture();
    await handle.prisma.billingAppKey.update({ where: { id: f.key.id }, data: { revokedAt: new Date() } });
    expect(await resolveOrgHostname({ domain: f.domain, orgSlug: f.org.slug }, f.deps)).toBeNull();
    expect(await resolveOrgById({ domain: f.domain, orgId: f.org.id }, f.deps)).toBeNull();
    expect(await resolveTeamById({ domain: f.domain, teamId: f.team.id }, f.deps)).toBeNull();
    expect(await resolveOrgHostname({ domain: f.org.domain, orgSlug: f.org.slug }, f.deps))
      .toMatchObject({ orgId: f.org.id });
  });

  it('refuses another domain claiming an existing address without hiding its original owner', async () => {
    const f = await fixture();
    await expect(withChosenOrganisationSlug(() => handle.prisma.organisation.create({ data: {
      domain: f.domain, ownerId: f.owner.id, name: 'Same label in another domain', slug: f.org.slug,
    } }))).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400, message: 'ORG_SLUG_TAKEN' });
    expect(await handle.prisma.organisation.count({ where: { slug: f.org.slug } })).toBe(1);
    expect(await resolveOrgHostname({ domain: f.domain, orgSlug: f.org.slug }, f.deps))
      .toMatchObject({ orgId: f.org.id, orgSlug: f.org.slug });
    expect(await resolveOrgById({ domain: f.domain, orgId: f.org.id }, f.deps))
      .toMatchObject({ orgId: f.org.id, orgSlug: f.org.slug });
    expect(await resolveTeamById({ domain: f.domain, teamId: f.team.id }, f.deps))
      .toMatchObject({ orgId: f.org.id, teamId: f.team.id });
    expect(await resolveTeamHostname({ domain: f.domain, orgSlug: f.org.slug, teamSlug: f.team.slug }, f.deps))
      .toMatchObject({ orgId: f.org.id, teamId: f.team.id });
  });

  it('does not publish inactive organisations or teams in the product namespace', async () => {
    const f = await fixture();
    await handle.prisma.team.update({ where: { id: f.team.id }, data: { lifecycleStatus: 'DISABLED' } });
    expect(await resolveTeamById({ domain: f.domain, teamId: f.team.id }, f.deps)).toBeNull();
    expect(await resolveTeamHostname({ domain: f.domain, orgSlug: f.org.slug, teamSlug: f.team.slug }, f.deps)).toBeNull();
    await handle.prisma.organisation.update({ where: { id: f.org.id }, data: { lifecycleStatus: 'DISABLED' } });
    expect(await resolveOrgHostname({ domain: f.domain, orgSlug: f.org.slug }, f.deps)).toBeNull();
    expect(await resolveOrgById({ domain: f.domain, orgId: f.org.id }, f.deps)).toBeNull();
  });
});
