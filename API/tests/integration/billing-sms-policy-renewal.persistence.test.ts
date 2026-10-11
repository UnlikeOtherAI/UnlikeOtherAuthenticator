import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { parseSmsFxEvidence } from '../../src/services/billing-sms-fx-evidence.service.js';
import { runSmsPolicyRenewalCycle } from '../../src/services/billing-sms-policy-renewal.service.js';

let prisma: PrismaClient;
let cleanup: () => Promise<void>;
const account = `AC${'e'.repeat(32)}`;
const operator = 'renewal-operator';
const day = 86_400_000;
// Whole seconds keep timestamp(3) round trips exact.
const start = new Date(Math.floor(Date.now() / 1000) * 1000);
const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const ecb = (date: string, rate: string) => '<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">' +
  `<Cube><Cube time="${date}"><Cube currency="USD" rate="${rate}"/></Cube></Cube></gesmes:Envelope>`;
// Fake account prices: GB outbound fell, GB inbound rose; CZ is manual evidence without a price.
const prices: Record<string, string> = { 'GB:outbound': '0.0550', 'GB:inbound': '0.0080', 'CZ:outbound': '0.0706' };
const provider = () => ({ configuration: { accountSid: account } as never,
  price: async (country: string, direction: string) => ({ amount: prices[`${country}:${direction}`] ?? '1',
    currency: 'USD', country, observedAt: start, source: `https://pricing.twilio.com/v1/Messaging/Countries/${country}` }) });
const policy = (id: string, country: string, direction: string, expiresInDays: number, providerPrice: string | null) => ({
  id, accountSid: account, country, direction, currency: 'USD', additionalPerSegment: direction === 'outbound' ? '0.01' : '0.007',
  additionalPerMessage: '0.002', source: `https://www.twilio.com/en-us/sms/pricing/${country.toLowerCase()}`,
  evidenceDigest: id.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'a'), acceptedBy: 'operator',
  acceptedByUserId: operator, acceptedAt: new Date(start.getTime() - 20 * day),
  expiresAt: new Date(start.getTime() + expiresInDays * day), acceptanceReason: 'Synthetic operator acceptance',
  providerPrice });

describe.skipIf(!process.env.DATABASE_URL)('SMS policy renewal job against PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('BILLING_SMS_POLICY_AUTORENEW_FX_BAND_BPS', '500');
    vi.stubEnv('BILLING_SMS_POLICY_AUTORENEW_LOOKAHEAD_DAYS', '7');
    const db = await createTestDb();
    if (!db) throw new Error('DATABASE_URL required for renewal verification');
    prisma = db.prisma; cleanup = db.cleanup;
    await prisma.$executeRaw(Prisma.sql`INSERT INTO users(id,email,user_key,name)
      VALUES (${operator},'renewal@example.test','renewal@example.test','Renewal operator')`);
    const previous = new Date(start.getTime() - 3 * day);
    await prisma.billingSmsFxSnapshot.create({ data: { id: 'fx-operator', policy: 'ECB_REFERENCE_USD_PER_EUR_V1',
      source: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', sourceDigest: 'f'.repeat(64),
      rateDate: new Date(`${isoDate(previous)}T00:00:00.000Z`), observedAt: previous, usdPerEur: '1.1186',
      expiresAt: new Date(new Date(`${isoDate(previous)}T00:00:00.000Z`).getTime() + 7 * day),
      acceptedByUserId: operator, acceptedAt: previous, acceptanceReason: 'Synthetic operator FX acceptance' } });
    for (const row of [policy('gb-out', 'GB', 'outbound', 3, '0.056'), policy('gb-in', 'GB', 'inbound', 3, '0.0075'),
      policy('cz-out', 'CZ', 'outbound', 2, null), policy('cz-in', 'CZ', 'inbound', 25, '0.0075')]) {
      await prisma.billingSmsRoutePolicy.create({ data: row });
    }
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (cleanup) await cleanup(); });

  it('appends renewals, alerts once per condition and never edits an accepted record', async () => {
    const original = await prisma.billingSmsRoutePolicy.findMany({ orderBy: { id: 'asc' } });
    const originalFx = await prisma.billingSmsFxSnapshot.findMany();
    const notify = vi.fn(async () => undefined);
    const yesterday = isoDate(new Date(start.getTime() - day));
    const deps = { prisma, notify, provider, readFx: async () => parseSmsFxEvidence(ecb(yesterday, '1.1201'), start) };
    expect(await runSmsPolicyRenewalCycle({ ...deps, now: () => start }))
      .toEqual({ fx: 'accepted', routes: { checked: 3, renewed: 1, alerted: 2 } });

    const fx = await prisma.billingSmsFxSnapshot.findFirstOrThrow({ where: { acceptedBy: 'renewal_job' } });
    expect(fx).toMatchObject({ acceptedByUserId: null, rateDate: new Date(`${yesterday}T00:00:00.000Z`),
      expiresAt: new Date(new Date(`${yesterday}T00:00:00.000Z`).getTime() + 7 * day) });
    expect(fx.usdPerEur.toFixed()).toBe('1.1201');
    expect(fx.acceptanceReason).toContain('within ±5.00% of the last accepted 1.1186');
    const renewal = await prisma.billingSmsRoutePolicy.findFirstOrThrow({ where: { acceptedBy: 'renewal_job' } });
    expect(renewal).toMatchObject({ renewalOfId: 'gb-out', acceptedByUserId: null, country: 'GB', direction: 'outbound',
      source: 'https://www.twilio.com/en-us/sms/pricing/gb', expiresAt: new Date(start.getTime() + 30 * day) });
    expect([renewal.additionalPerSegment.toFixed(), renewal.additionalPerMessage.toFixed(), renewal.providerPrice?.toFixed()])
      .toEqual(['0.01', '0.002', '0.055']);
    // Originals are byte-for-byte what was accepted.
    expect(await prisma.billingSmsRoutePolicy.findMany({ where: { acceptedBy: 'operator' }, orderBy: { id: 'asc' } })).toEqual(original);
    expect(await prisma.billingSmsFxSnapshot.findMany({ where: { acceptedBy: 'operator' } })).toEqual(originalFx);

    const open = await prisma.billingSmsPolicyAlert.findMany({ where: { resolvedAt: null }, orderBy: { kind: 'asc' } });
    expect(open.map((row) => [row.kind, row.subject])).toEqual([
      ['route_needs_operator', `${account}:CZ:outbound:USD`], ['route_price_rose', `${account}:GB:inbound:USD`]]);
    expect(open[1]?.message).toContain('rose from USD 0.0075 to 0.008');
    expect(notify).toHaveBeenCalledTimes(2);

    // A second pass, as another instance would run it, adds nothing and emails nobody.
    const later = new Date(start.getTime() + 60_000);
    expect(await runSmsPolicyRenewalCycle({ ...deps, now: () => later }))
      .toEqual({ fx: 'current', routes: { checked: 2, renewed: 0, alerted: 2 } });
    expect(await prisma.billingSmsRoutePolicy.count()).toBe(5);
    expect(await prisma.billingSmsFxSnapshot.count()).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect((await prisma.billingSmsPolicyAlert.findMany({ where: { resolvedAt: null } }))
      .every((row) => row.lastSeenAt.getTime() === later.getTime())).toBe(true);
  });

  it('alerts on an out-of-band or unavailable ECB document and clears route alerts once covered', async () => {
    const notify = vi.fn(async () => undefined);
    const now = new Date(start.getTime() + 120_000);
    const outside = await runSmsPolicyRenewalCycle({ prisma, notify, provider, now: () => now,
      readFx: async () => parseSmsFxEvidence(ecb(isoDate(now), '1.3000'), now) });
    expect(outside.fx).toBe('alerted');
    expect(await prisma.billingSmsFxSnapshot.count()).toBe(2);
    expect(notify.mock.calls.map(([condition]) => (condition as { kind: string }).kind)).toEqual(['fx_outside_band']);
    await runSmsPolicyRenewalCycle({ prisma, notify, provider, now: () => now,
      readFx: async () => { throw new Error('ECB unreachable'); } });
    const fxAlerts = await prisma.billingSmsPolicyAlert.findMany({ where: { subject: 'ECB_REFERENCE_USD_PER_EUR_V1' } });
    expect(fxAlerts.filter((row) => row.resolvedAt === null).map((row) => row.kind)).toEqual(['fx_unavailable']);

    // An operator re-accepts CZ outbound with a recorded price; its alert resolves on the next pass.
    await prisma.billingSmsRoutePolicy.create({ data: { ...policy('cz-out-again', 'CZ', 'outbound', 30, '0.0706'),
      acceptedAt: now } });
    await runSmsPolicyRenewalCycle({ prisma, notify, provider, now: () => now,
      readFx: async () => { throw new Error('ECB unreachable'); } });
    expect(await prisma.billingSmsPolicyAlert.count({ where: { subject: `${account}:CZ:outbound:USD`, resolvedAt: null } })).toBe(0);
  });

  it('keeps the database refusing edits and any renewal that is not an exact re-attestation', async () => {
    await expect(prisma.billingSmsRoutePolicy.update({ where: { id: 'gb-out' }, data: { acceptanceReason: 'Rewritten reason' } }))
      .rejects.toThrow();
    await expect(prisma.billingSmsFxSnapshot.update({ where: { id: 'fx-operator' }, data: { acceptanceReason: 'Rewritten' } }))
      .rejects.toThrow();
    const renewal = { ...policy('bad-renewal', 'GB', 'outbound', 30, '0.057'), acceptedBy: 'renewal_job',
      acceptedByUserId: null, renewalOfId: 'gb-out' };
    await expect(prisma.billingSmsRoutePolicy.create({ data: renewal })).rejects.toThrow();
    await expect(prisma.billingSmsRoutePolicy.create({ data: { ...renewal, id: 'bad-bounds', providerPrice: '0.05',
      additionalPerSegment: '0.001' } })).rejects.toThrow();
    await expect(prisma.billingSmsRoutePolicy.create({ data: { ...renewal, id: 'no-subject', providerPrice: '0.05',
      acceptedBy: 'operator' } })).rejects.toThrow();
  });
});
