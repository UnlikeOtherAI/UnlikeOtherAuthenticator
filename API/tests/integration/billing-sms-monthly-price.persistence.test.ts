import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { smsPaidNumberFixture } from '../helpers/sms-paid-number-fixture.js';
import { smsAccount, smsIds } from '../helpers/sms-financial-fixture.js';
import { issueSmsQuote } from '../../src/services/billing-sms-quote.service.js';
import { beginSmsNumber } from '../../src/services/billing-sms-number.service.js';
import { BillingSmsProvider } from '../../src/services/billing-sms-provider.service.js';

const checkout = vi.hoisted(() => ({ createRecurringAddonCheckout: vi.fn(async () => undefined) }));
vi.mock('../../src/services/billing-recurring-addon-checkout.service.js', () => checkout);

let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let fixture: Awaited<ReturnType<typeof smsPaidNumberFixture>>;
const phone = '+447463595266';
// Monthly rental per country in USD; CH is priced above the flat EUR 4.99 at the fixture's USD/EUR 1.1.
const rental: Record<string, string> = { GB: '1.15', CZ: '2.20', CH: '6.00' };
const provider = new BillingSmsProvider({ accountSid: smsAccount, apiKeySid: `SK${'b'.repeat(32)}`,
  apiKeySecret: 'synthetic-unused-secret' }, async (url) => {
  const address = String(url);
  const country = /Countries\/([A-Z]{2})/.exec(address)?.[1] ?? 'GB';
  if (address.includes('/PhoneNumbers/Countries/')) return new Response(JSON.stringify({ country, iso_country: country,
    price_unit: 'usd', phone_number_prices: [{ number_type: 'mobile', base_price: rental[country], current_price: rental[country] }] }));
  if (address.includes('/AvailablePhoneNumbers/')) return new Response(JSON.stringify({ available_phone_numbers: [{
    phone_number: phone, iso_country: 'GB', capabilities: { MMS: false, SMS: true, voice: true } }] }));
  return new Response('{}', { status: 404 });
});
const subject = { product: 'nessie', organisation_id: smsIds.org, team_id: smsIds.team, user_id: smsIds.user };
function monthly(country: string) {
  return issueSmsQuote({ credential: fixture.entitlement, authorize: async () => undefined, request: { ...subject,
    country, number_type: 'mobile', direction: 'monthly', destination: null, carrier: null, mcc: null, mnc: null } },
  { prisma, provider });
}

describe.skipIf(!process.env.DATABASE_URL)('Flat monthly SMS number price', () => {
  beforeAll(async () => {
    vi.stubEnv('UOA_SMS_COMMERCIAL_POLICY_VERSION', 'synthetic-policy');
    vi.stubEnv('UOA_SMS_PRICING_MODE', 'provider_markup');
    vi.stubEnv('UOA_SMS_PROVIDER_MARKUP_BPS', '1500');
    const db = await createTestDb();
    if (!db) throw new Error('Monthly price tests require DATABASE_URL');
    prisma = db.prisma; cleanup = db.cleanup; fixture = await smsPaidNumberFixture(prisma);
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (cleanup) await cleanup(); });

  it('quotes the seeded flat EUR 4.99 in every country and freezes the price row it used', async () => {
    for (const country of ['GB', 'CZ']) {
      const quote = await monthly(country);
      expect(quote).toMatchObject({ amount: '4.99', currency: 'EUR', rate_basis: 'monthly_mobile',
        scope: { country, direction: 'monthly' } });
      expect(await prisma.billingSmsQuote.findUniqueOrThrow({ where: { id: quote.id } })).toMatchObject({
        monthlyPriceId: 'sms-monthly-price-seed-eur-4-99', finalCurrency: 'EUR', monthlyMarkupBps: 0 });
    }
  });

  it('refuses a country whose rental reaches the flat price, raises one alert and clears it once covered', async () => {
    await expect(monthly('CH')).rejects.toThrow('BILLING_SMS_MONTHLY_PRICE_BELOW_COST');
    await expect(monthly('CH')).rejects.toThrow('BILLING_SMS_MONTHLY_PRICE_BELOW_COST');
    const open = await prisma.billingSmsPolicyAlert.findMany({ where: { subject: 'monthly:CH', resolvedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'monthly_price_below_cost' });
    expect(open[0]?.message).toContain('USD 6.00 a month');
    expect(await prisma.billingSmsQuote.count({ where: { country: 'CH' } })).toBe(0);
    rental.CH = '4.00';
    expect(await monthly('CH')).toMatchObject({ amount: '4.99', currency: 'EUR' });
    expect(await prisma.billingSmsPolicyAlert.count({ where: { subject: 'monthly:CH', resolvedAt: null } })).toBe(0);
  });

  it('begins a number on an EUR quote with an EUR offer and catalog at the exact minor amount', async () => {
    const quote = await monthly('GB');
    await beginSmsNumber({ credential: fixture.lifecycle, actorToken: await fixture.actor('/billing/v1/sms/numbers/begin'),
      request: { ...subject, resource_id: 'sms-number-eur', quote_id: quote.id, phone_number: phone } },
    { prisma, provider, stripe: fixture.stripe, stripeLivemode: false });
    const resource = await prisma.billingSmsNumberResource.findUniqueOrThrow({ where: { id: 'sms-number-eur' } });
    const offer = await prisma.billingRecurringAddonOffer.findUniqueOrThrow({ where: { id: resource.offerId! },
      include: { catalogs: true } });
    expect(offer).toMatchObject({ currency: 'EUR', monthlyAmountMinor: 499n, resourceKind: 'sms_mobile_number' });
    expect(offer.catalogs).toEqual([expect.objectContaining({ currency: 'EUR', monthlyAmountMinor: 499n })]);
    expect(checkout.createRecurringAddonCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ offerId: offer.id }) }), expect.anything());
  });

  it('admits a per-currency SMS Customer beside the organisation one and nothing else', async () => {
    const base = { accountId: smsIds.account, orgId: smsIds.org, scope: 'ORGANISATION' as const };
    await prisma.billingStripeCustomer.create({ data: { ...base, scopeKey: `${smsIds.org}:sms:EUR` } });
    await expect(prisma.billingStripeCustomer.create({ data: { ...base, scopeKey: `${smsIds.org}:sms:GBP` } }))
      .rejects.toThrow();
  });

  it('keeps the price append-only and lets an operator row become current', async () => {
    await expect(prisma.billingSmsMonthlyPrice.update({ where: { id: 'sms-monthly-price-seed-eur-4-99' },
      data: { amount: '1.00' } })).rejects.toThrow();
    await prisma.billingSmsMonthlyPrice.create({ data: { amount: '12.00', currency: 'USD', setBy: 'operator',
      setByUserId: smsIds.user, setAt: new Date(Date.now() + 1000) } });
    expect(await monthly('CZ')).toMatchObject({ amount: '12.00', currency: 'USD' });
    await expect(prisma.billingSmsMonthlyPrice.create({ data: { amount: '1.00', currency: 'GBP', setBy: 'seed' } }))
      .rejects.toThrow();
  });
});
