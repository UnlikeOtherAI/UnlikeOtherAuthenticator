import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRlsTestDb } from '../helpers/test-db.js';
import { seedSmsFinance, smsIds, smsCredential } from '../helpers/sms-financial-fixture.js';
import { getProductEntitlement } from '../../src/services/billing-product-entitlement.service.js';
import { recordStorageObservation } from '../../src/services/billing-storage-expansion.service.js';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';

describe.skipIf(!process.env.DATABASE_URL)('commercial company authority and measurement persistence', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createRlsTestDb>>>;
  let runtime: PrismaClient;
  const request = { product: 'nessie', organisation_id: smsIds.org };
  const credential: VerifiedBillingAppKey = { ...smsCredential, id: 'commercial-worker', purpose: 'COMMERCIAL_WORKER' };
  beforeAll(async () => {
    const handle = await createRlsTestDb(); if (!handle) throw new Error('DATABASE_URL_REQUIRED'); db = handle;
    await seedSmsFinance(db.prisma, false);
    await db.prisma.clientDomain.create({ data: { domain: 'authentication.unlikeotherai.com', label: 'Registered source' } });
    await db.prisma.billingAppKey.create({ data: { id: credential.id, serviceId: smsIds.service,
      purpose: 'COMMERCIAL_WORKER', name: 'Synthetic company worker', keyPrefix: 'worker', secretDigest: 'worker',
      actorIssuer: credential.actorIssuer, actorAudience: credential.actorAudience, actorKeyId: credential.actorKeyId, actorPublicJwk: {} } });
    await db.prisma.billingProductEnrollment.create({ data: { serviceId: smsIds.service, orgId: smsIds.org,
      sourceDomain: 'authentication.unlikeotherai.com' } });
    runtime = new PrismaClient({ datasources: { db: { url: db.appDatabaseUrl } } });
  }, 120_000);
  afterAll(async () => { await runtime?.$disconnect(); await db?.cleanup(); });
  it('does not implicitly admit a person through an organisation-only background projection', async () => {
    const result = await getProductEntitlement({ request, credential }, { prisma: db.prisma });
    expect(result.viewer).toBe('background'); expect(result.subject).toBeNull();
    expect(result.seats.admitted).toBe(false); expect(result.history_window_days).toBe(14);
    expect(result.storage.capacity_bytes).toBe('100000000');
    const member = await getProductEntitlement({ request: { ...request, team_id: smsIds.team, user_id: smsIds.user }, credential }, { prisma: db.prisma });
    expect(member.subject).toEqual({ team_id: smsIds.team, user_id: smsIds.user }); expect(member.seats.admitted).toBe(true);
  });
  it('serializes conflicting concurrent revisions and retains stale observation authority', async () => {
    const observation = { ...request, observation_id: 'snapshot-a', revision: '1', measurement_version: 'content-v1',
      observed_at: new Date().toISOString(), blob_bytes: '17', database_bytes: '23' };
    const results = await Promise.allSettled([recordStorageObservation({ request: observation, credential }, { prisma: db.prisma }),
      recordStorageObservation({ request: { ...observation, observation_id: 'snapshot-b' }, credential }, { prisma: db.prisma })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await recordStorageObservation({ request: { ...observation, revision: '0', observation_id: 'older', blob_bytes: '0', database_bytes: '0' }, credential },
      { prisma: db.prisma })).toEqual({ accepted: true, superseded: true, revision: '1' });
    const snapshot = await getProductEntitlement({ request, credential }, { prisma: db.prisma });
    expect(snapshot.storage.used_bytes).toBe('40');
  });
  it('denies cross-company, cross-team and revoked source/key authority', async () => {
    await expect(getProductEntitlement({ request: { ...request, organisation_id: 'another-company' }, credential }, { prisma: db.prisma })).rejects.toThrow();
    await expect(getProductEntitlement({ request: { ...request, user_id: smsIds.user, team_id: 'another-team' }, credential }, { prisma: db.prisma })).rejects.toThrow();
    await db.prisma.billingAppKey.update({ where: { id: credential.id }, data: { revokedAt: new Date() } });
    await expect(getProductEntitlement({ request, credential }, { prisma: db.prisma })).rejects.toThrow();
  });
  it('keeps commercial facts behind the runtime RLS boundary', async () => {
    expect(await runtime.billingProductEnrollment.findMany()).toEqual([]);
    expect(await runtime.billingStorageObservation.findMany()).toEqual([]);
    await expect(runtime.billingProductEnrollment.create({ data: { serviceId: smsIds.service, orgId: smsIds.org,
      sourceDomain: 'authentication.unlikeotherai.com' } })).rejects.toThrow();
  });
});
