import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import {
  billingRegionView, requireOrganisationBillingRegion,
} from '../../src/services/billing-organisation-region.service.js';

let prisma: PrismaClient;
let cleanup: () => Promise<void>;

describe.skipIf(!process.env.DATABASE_URL)('organisation billing region in PostgreSQL', () => {
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('Region tests require DATABASE_URL');
    prisma = db.prisma; cleanup = db.cleanup;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`INSERT INTO users(id,email,user_key,name) VALUES ('region-user','r@example.test','r@example.test','R')`);
      for (const id of ['region-org', 'region-org-2']) {
        await tx.$executeRaw(Prisma.sql`INSERT INTO organisations(id,domain,name,slug,owner_id,updated_at)
          VALUES (${id},${`${id}.example.test`},'Region',${id},'region-user',CURRENT_TIMESTAMP)`);
      }
    });
  });
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('reads null and refuses SMS work until chosen, then shows the chosen region', async () => {
    expect(await billingRegionView('region-org', true, prisma)).toEqual({ region: null, currency: null,
      suggested_region: 'US', suggested_currency: 'USD', suggested_from: null, can_set: true });
    await expect(requireOrganisationBillingRegion('region-org', prisma)).rejects.toThrow('BILLING_REGION_REQUIRED');
    await prisma.billingOrganisationRegion.create({ data: { orgId: 'region-org', region: 'UK', currency: 'GBP',
      setByUserId: 'region-user' } });
    expect(await requireOrganisationBillingRegion('region-org', prisma)).toEqual({ region: 'UK', currency: 'GBP' });
    expect(await billingRegionView('region-org', true, prisma)).toMatchObject({ region: 'UK', currency: 'GBP', can_set: false });
  });

  it('refuses a second row, any update and a currency that does not match the region', async () => {
    await expect(prisma.billingOrganisationRegion.create({ data: { orgId: 'region-org', region: 'US', currency: 'USD',
      setByUserId: 'region-user' } })).rejects.toThrow();
    await expect(prisma.billingOrganisationRegion.update({ where: { orgId: 'region-org' },
      data: { region: 'US', currency: 'USD' } })).rejects.toThrow('BILLING_REGION_IMMUTABLE');
    await expect(prisma.$executeRaw(Prisma.sql`UPDATE billing_organisation_regions SET set_at = now()
      WHERE org_id = 'region-org'`)).rejects.toThrow('BILLING_REGION_IMMUTABLE');
    await expect(prisma.billingOrganisationRegion.create({ data: { orgId: 'region-org-2', region: 'EUROPE',
      currency: 'USD', setByUserId: 'region-user' } })).rejects.toThrow();
    expect(await prisma.billingOrganisationRegion.findUniqueOrThrow({ where: { orgId: 'region-org' } }))
      .toMatchObject({ region: 'UK', currency: 'GBP' });
  });
});
