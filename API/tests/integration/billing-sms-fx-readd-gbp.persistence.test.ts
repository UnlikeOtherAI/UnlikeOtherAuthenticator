import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';
import { parseSmsFxEvidence } from '../../src/services/billing-sms-fx-evidence.service.js';
import { smsMonthlyTerms } from '../../src/services/billing-sms-monthly-price.service.js';
import {
  insertSmsFxPolicy,
  smsFxPolicyValue,
  smsFxReaddGbpReason,
} from '../../src/services/billing-sms-policy-admin.service.js';
import { runSmsPolicyRenewalCycle } from '../../src/services/billing-sms-policy-renewal.service.js';

const operator = 'fx-readd-operator';
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
const date = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
// The one ECB document of the day: it always carried GBP, but it was first accepted before GBP was read.
const xml = '<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">' +
  `<Cube><Cube time="${date}"><Cube currency="USD" rate="1.1181"/><Cube currency="GBP" rate="0.8712"/></Cube></Cube>` +
  '</gesmes:Envelope>';
const digest = createHash('sha256').update(xml).digest('hex');
// No route policies exist here, so the provider is never asked for a price.
const noRoutes = () => ({ configuration: { accountSid: `AC${'d'.repeat(32)}` } as never,
  price: async () => { throw new Error('no route policy to renew'); } });
const latest = (db: PrismaClient) => db.billingSmsFxSnapshot.findFirstOrThrow({
  where: { policy: 'ECB_REFERENCE_USD_PER_EUR_V1' }, orderBy: [{ rateDate: 'desc' }, { acceptedAt: 'desc' }] });
const rates = (row: { usdPerEur: Prisma.Decimal; gbpPerEur: Prisma.Decimal | null }) =>
  ({ usdPerEur: row.usdPerEur.toFixed(), gbpPerEur: row.gbpPerEur?.toFixed() ?? null });
const gbQuote = (db: PrismaClient, row: Parameters<typeof rates>[0]) => smsMonthlyTerms(db, { country: 'GB',
  currency: 'GBP', providerAmount: '1.15', providerCurrency: 'USD', rates: rates(row) });

describe.skipIf(!process.env.DATABASE_URL)('re-accepting a dated ECB document to add GBP (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    vi.stubEnv('BILLING_SMS_POLICY_AUTORENEW_FX_BAND_BPS', '500');
    vi.stubEnv('BILLING_SMS_POLICY_AUTORENEW_LOOKAHEAD_DAYS', '7');
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required for FX verification');
    prisma = db.prisma; cleanup = db.cleanup;
    await prisma.$executeRaw(Prisma.sql`INSERT INTO users(id,email,user_key,name)
      VALUES (${operator},'fx-readd@example.test','fx-readd@example.test','FX operator')`);
    const rateDate = new Date(`${date}T00:00:00.000Z`);
    await prisma.billingSmsFxSnapshot.create({ data: { id: 'fx-without-gbp', policy: 'ECB_REFERENCE_USD_PER_EUR_V1',
      source: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', sourceDigest: digest, rateDate,
      observedAt: rateDate, usdPerEur: '1.1181', expiresAt: new Date(rateDate.getTime() + 7 * 86_400_000),
      acceptedBy: 'renewal_job', acceptedByUserId: null, acceptedAt: new Date(now.getTime() - 3_600_000),
      acceptanceReason: 'Automatic renewal before GBP was read' } });
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (cleanup) await cleanup(); });

  it('refuses a GBP monthly quote while the only acceptance lacks GBP', async () => {
    await expect(gbQuote(prisma, await latest(prisma))).rejects.toThrow('BILLING_SMS_FX_POLICY_REQUIRED');
  });

  it('accepts the same document again as a new version with GBP, keeping its date-bound validity', async () => {
    const deps = { prisma, notify: vi.fn(async () => undefined), provider: noRoutes,
      readFx: async () => parseSmsFxEvidence(xml, now), now: () => now };
    const result = await runSmsPolicyRenewalCycle(deps);
    expect(result.fx).toBe('accepted');

    const rows = await prisma.billingSmsFxSnapshot.findMany({ where: { sourceDigest: digest }, orderBy: { acceptedAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'fx-without-gbp', gbpPerEur: null });
    expect(rows[1]?.gbpPerEur?.toFixed()).toBe('0.8712');
    expect(rows[1]?.expiresAt).toEqual(rows[0]?.expiresAt);
    expect(rows[1]?.rateDate).toEqual(rows[0]?.rateDate);
    expect(rows[1]?.acceptanceReason).toContain(`Re-accepted the same ECB ${date} document to add GBP 0.8712`);
    expect(rows[1]?.acceptanceReason).toContain(smsFxReaddGbpReason(date, '0.8712'));
    // The monthly GBP price now converts.
    expect(await gbQuote(prisma, await latest(prisma))).toMatchObject({ finalAmount: '4.49', finalCurrency: 'GBP' });
  });

  it('never accepts the same document a third time, from the job or Refresh and accept', async () => {
    const result = await runSmsPolicyRenewalCycle({ prisma, notify: vi.fn(async () => undefined),
      provider: noRoutes, readFx: async () => parseSmsFxEvidence(xml, now), now: () => now });
    expect(result.fx).toBe('current');
    const value = smsFxPolicyValue(parseSmsFxEvidence(xml, now));
    const again = await prisma.$transaction((tx) => insertSmsFxPolicy(tx, value,
      { kind: 'operator', actor: { userId: operator } as never }, now, 'Refresh and accept'));
    expect(again.gbpPerEur?.toFixed()).toBe('0.8712');
    expect(await prisma.billingSmsFxSnapshot.count({ where: { sourceDigest: digest } })).toBe(2);
    await expect(prisma.billingSmsFxSnapshot.create({ data: { policy: 'ECB_REFERENCE_USD_PER_EUR_V1',
      source: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', sourceDigest: digest,
      rateDate: new Date(`${date}T00:00:00.000Z`), observedAt: now, usdPerEur: '1.1181', gbpPerEur: '0.8712',
      expiresAt: new Date(now.getTime() + 86_400_000), acceptedBy: 'renewal_job', acceptedByUserId: null,
      acceptanceReason: 'duplicate' } })).rejects.toThrow();
  });
});
