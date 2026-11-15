import { describe, expect, it } from 'vitest';
import { reservePrepaidDispatch } from '../../src/services/billing-prepaid-reservation.service.js';
import { createBillingService, createBillingTariffVersion, setDefaultBillingTariff } from '../../src/services/billing-tariff.service.js';
import { ids, secret, prisma, delegation, admissionInput, setupPersistenceSuite, enabled } from './billing-prepaid-reservation.suite-fixture.js';

const actor = { email: 'billing-operator@example.test' };
const standard = { key: 'standard-usd', name: 'Regular', mode: 'standard' as const,
  collectionMode: 'stripe' as const, monthlyAmountMinor: '399', monthlyChargeBasis: 'per_seat' as const,
  usagePaymentMode: 'prepaid' as const, currency: 'USD' };
const unfunded = { ...standard, key: 'unfunded', mode: 'at_cost' as const,
  collectionMode: 'none' as const, monthlyAmountMinor: '0', monthlyChargeBasis: 'flat' as const,
  usagePaymentMode: 'pay_as_you_go' as const };

async function reserve(dispatchId: string, rawCostBound = '0.00000001') {
  const input = { ...admissionInput(dispatchId), product: 'nessie', rawCostBound };
  return reservePrepaidDispatch({ runtimeSecret: secret, input, delegation: await delegation({ product: 'nessie' }) },
    { prisma, now: new Date(input.dispatchStartedAt), cardOnFile: async () => undefined });
}

describe.skipIf(!enabled)('Nessie payment gate at the real reservation interface', () => {
  setupPersistenceSuite('nessie');

  it('rejects an uncollected default for new dispatches and legacy PAYG replays without making a hold', async () => {
    const old = await prisma.billingTariff.create({ data: { serviceId: ids.service, key: 'at-cost', version: 1,
      name: 'Uncollected default', mode: 'AT_COST', collectionMode: 'NONE', markupBps: 0,
      currency: 'USD', usagePaymentMode: 'PAY_AS_YOU_GO' } });
    await prisma.billingTariffTermEvent.create({ data: { serviceId: ids.service, source: 'SERVICE_DEFAULT',
      scopeKey: ids.service, effectiveFromMonth: '2026-10', tariffId: old.id, reason: 'Historical default fixture' } });
    await prisma.billingLedgerDispatchDecision.create({ data: { dispatchId: 'legacy-payg',
      requestFingerprint: 'b'.repeat(64), runtimeKeyId: ids.key, serviceId: ids.service,
      providerServiceId: 'openai', orgId: ids.org, teamId: ids.team, userId: ids.user,
      billingMonth: '2026-10', dispatchStartedAt: new Date('2026-10-04T12:00:00Z'),
      currency: 'USD', rawCostBound: '0.00000001', status: 'PAY_AS_YOU_GO' } });
    for (const dispatchId of ['new-unfunded', 'legacy-payg']) {
      await expect(reserve(dispatchId)).rejects.toMatchObject({ statusCode: 402, message: 'NESSIE_PREPAID_SETUP_REQUIRED' });
      expect(await prisma.billingPrepaidReservation.count({ where: { dispatchId } })).toBe(0);
      expect(await prisma.billingCreditBudgetDispatch.count({ where: { dispatchId } })).toBe(0);
    }
  });

  it('refuses nonregular default writes through creation, versioning and default selection', async () => {
    await expect(createBillingService({ identifier: 'nessie', name: 'Nessie', defaultTariff: unfunded, actor }, { prisma }))
      .rejects.toThrow('NESSIE_REGULAR_DEFAULT_REQUIRED');
    await expect(createBillingTariffVersion({ serviceId: ids.service, tariff: unfunded, setAsDefault: true, actor }, { prisma }))
      .rejects.toThrow('NESSIE_REGULAR_DEFAULT_REQUIRED');
    await expect(setDefaultBillingTariff({ serviceId: ids.service, tariffId: ids.tariff, actor }, { prisma }))
      .rejects.toThrow('NESSIE_REGULAR_DEFAULT_REQUIRED');
    await expect(createBillingTariffVersion({ serviceId: ids.service, tariff: unfunded, setAsDefault: false, actor }, { prisma }))
      .resolves.toMatchObject({ isDefault: false });
  });

  it('requires funded capacity under regular terms and never creates a PAYG decision on exhaustion', async () => {
    const tariff = await createBillingTariffVersion({ serviceId: ids.service, tariff: standard, setAsDefault: true, actor }, { prisma });
    // The fixture binds October dispatches; production default mutations remain prospective.
    await prisma.billingTariffTermEvent.create({ data: { serviceId: ids.service, source: 'SERVICE_DEFAULT',
      scopeKey: ids.service, effectiveFromMonth: '2026-10', tariffId: tariff.id, reason: 'Regular dispatch fixture' } });
    await expect(reserve('insufficient-funds', '1')).rejects.toMatchObject({ statusCode: 402, message: 'PREPAID_CREDIT_EXHAUSTED' });
    expect(await prisma.billingLedgerDispatchDecision.count({ where: { dispatchId: 'insufficient-funds' } })).toBe(0);
    await expect(reserve('funded-dispatch')).resolves.toMatchObject({ payment_mode: 'prepaid' });
    await expect(reserve('legacy-payg')).rejects.toMatchObject({ statusCode: 409, message: 'PREPAID_DISPATCH_CONFLICT' });
  });
});
