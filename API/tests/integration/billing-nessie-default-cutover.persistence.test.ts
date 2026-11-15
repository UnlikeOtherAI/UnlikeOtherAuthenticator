import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ids, prisma, setupPersistenceSuite, enabled } from './billing-prepaid-reservation.suite-fixture.js';

// Exercise the migration's exact data cutover after seeding the prior published catalogue.
// Full migration DDL is also applied by the shared fresh-database fixture.
const migration = new URL('../../prisma/migrations/20261115151000_nessie_regular_default/migration.sql', import.meta.url);
async function cutover() {
  const sql = await readFile(migration, 'utf8');
  const start = sql.indexOf('DO $$');
  const end = sql.indexOf('CREATE FUNCTION billing_guard_nessie_regular_default');
  await prisma.$executeRawUnsafe(sql.slice(start, end));
}
async function publish(currency: string, amount: bigint) {
  return prisma.billingTariff.create({ data: { serviceId: ids.service, key: `standard-${currency.toLowerCase()}`,
    version: 1, name: `Regular ${currency}`, currency, usageCurrency: currency, mode: 'STANDARD',
    collectionMode: 'STRIPE', markupBps: 0, monthlyChargeBasis: 'PER_SEAT', monthlyAmountMinor: amount,
    seatPolicy: 'AUTOMATIC', seatChargeTiming: 'PRORATED', usagePaymentMode: 'PREPAID', anniversarySeats: false } });
}

describe.skipIf(!enabled)('Nessie published default cutover', () => {
  setupPersistenceSuite('nessie');
  it('rolls back an incomplete catalogue, then publishes prospective regional terms without rewriting history or charging', async () => {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingTariff.update({ where: { id: ids.tariff }, data: { isDefault: true,
        mode: 'AT_COST', usagePaymentMode: 'PAY_AS_YOU_GO' } });
    });
    const historical = await prisma.billingTariff.findUniqueOrThrow({ where: { id: ids.tariff } });
    const past = await prisma.billingTariffTermEvent.findMany({ where: { serviceId: ids.service }, orderBy: { sequence: 'asc' } });
    const usd = await publish('USD', 399n);
    await expect(cutover()).rejects.toThrow('Publish the approved regular regional seat catalog');
    expect(await prisma.billingTariff.findUnique({ where: { id: ids.tariff } })).toMatchObject({ isDefault: true });
    expect(await prisma.billingTariff.count({ where: { serviceId: ids.service, version: 2 } })).toBe(0);
    const eur = await publish('EUR', 299n), gbp = await publish('GBP', 299n);
    await cutover();
    const current = await prisma.billingTariff.findMany({ where: { serviceId: ids.service, version: 2 } });
    expect(current).toHaveLength(3);
    for (const original of [usd, eur, gbp]) {
      expect(current.find(row => row.currency === original.currency)).toMatchObject({ key: original.key,
        anniversarySeats: true, usageCurrency: 'USD', usagePaymentMode: 'PREPAID', monthlyAmountMinor: original.monthlyAmountMinor });
      expect(await prisma.billingTariff.findUnique({ where: { id: original.id } })).toEqual(original);
    }
    expect(await prisma.billingTariff.findUnique({ where: { id: ids.tariff } })).toEqual({ ...historical, isDefault: false });
    expect(current.filter(row => row.isDefault).map(row => row.currency)).toEqual(['USD']);
    for (const event of past) expect(await prisma.billingTariffTermEvent.findUnique({ where: { id: event.id } })).toEqual(event);
    const [newTerm] = await prisma.billingTariffTermEvent.findMany({ where: { serviceId: ids.service,
      reason: 'nessie-regular-default' } });
    const now = new Date();
    expect(newTerm?.effectiveFromMonth).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7));
    expect(await prisma.billingStripeCheckoutSession.count({ where: { serviceId: ids.service } })).toBe(0);
    expect(await prisma.billingStripeSubscription.count({ where: { serviceId: ids.service } })).toBe(0);
  });
});
