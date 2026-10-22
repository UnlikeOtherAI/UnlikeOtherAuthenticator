import { vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
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
// Monthly rental per country in USD; CH is priced above the flat EUR 4.99 at the test rates.
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
function monthly(country: string, organisationId = smsIds.org) {
  return issueSmsQuote({ credential: fixture.entitlement, authorize: async () => undefined, request: { ...subject,
    organisation_id: organisationId,
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
    // A newer accepted ECB document carrying GBP: USD 1.10 and GBP 0.85 per EUR.
    const created = new Date(Date.now() - 30_000);
    await prisma.billingSmsFxSnapshot.create({ data: { id: 'sms-fx-gbp', policy: 'ECB_REFERENCE_USD_PER_EUR_V1',
      source: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', sourceDigest: 'c'.repeat(64),
      rateDate: new Date(Date.now() + 86_400_000), observedAt: created, acceptedAt: created,
      expiresAt: new Date(Date.now() + 3_600_000), usdPerEur: '1.1', gbpPerEur: '0.85',
      acceptedByUserId: smsIds.user, acceptanceReason: 'Synthetic GBP-bearing fixture' } });
    for (const [id, region] of [['sms-org-uk', 'UK'], ['sms-org-us', 'US']] as const) {
      await prisma.$executeRaw(Prisma.sql`INSERT INTO organisations(id,domain,name,slug,owner_id,updated_at)
        VALUES (${id},${`${id}.example.test`},'SMS',${id},${smsIds.user},CURRENT_TIMESTAMP)`);
      await prisma.billingOrganisationRegion.create({ data: { orgId: id, region,
        currency: region === 'UK' ? 'GBP' : 'USD', setByUserId: smsIds.user } });
    }
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (cleanup) await cleanup(); });

  it('refuses a monthly quote until the organisation has chosen its billing region', async () => {
    await expect(monthly('GB')).rejects.toThrow('BILLING_REGION_REQUIRED');
    await prisma.billingOrganisationRegion.create({ data: { orgId: smsIds.org, region: 'EUROPE', currency: 'EUR',
      setByUserId: smsIds.user } });
  });

  it("quotes each region's seeded flat price in every country and freezes the price row it used", async () => {
    for (const [organisationId, amount, currency] of [[smsIds.org, '4.99', 'EUR'], ['sms-org-uk', '4.49', 'GBP'],
      ['sms-org-us', '5.49', 'USD']] as const) {
      for (const country of ['GB', 'CZ']) {
        const quote = await monthly(country, organisationId);
        expect(quote).toMatchObject({ amount, currency, rate_basis: 'monthly_mobile',
          scope: { country, direction: 'monthly', organisation_id: organisationId } });
        expect(await prisma.billingSmsQuote.findUniqueOrThrow({ where: { id: quote.id } })).toMatchObject({
          monthlyPriceId: `sms-monthly-price-seed-${currency.toLowerCase()}`, finalCurrency: currency,
          monthlyMarkupBps: 0, fxSnapshotId: 'sms-fx-gbp' });
      }
    }
  });

  it('refuses a country whose rental reaches the flat price, raises one alert and clears it once covered', async () => {
    // A USD 6.00 rental is EUR 5.4545 and GBP 4.6364: at or above all three flat prices.
    for (const organisationId of [smsIds.org, 'sms-org-uk', 'sms-org-us']) {
      await expect(monthly('CH', organisationId)).rejects.toThrow('BILLING_SMS_MONTHLY_PRICE_BELOW_COST');
    }
    await expect(monthly('CH')).rejects.toThrow('BILLING_SMS_MONTHLY_PRICE_BELOW_COST');
    const open = await prisma.billingSmsPolicyAlert.findMany({ where: { subject: { startsWith: 'monthly:CH:' },
      resolvedAt: null }, orderBy: { subject: 'asc' } });
    expect(open.map((row) => row.subject)).toEqual(['monthly:CH:EUR', 'monthly:CH:GBP', 'monthly:CH:USD']);
    expect(open[0]).toMatchObject({ kind: 'monthly_price_below_cost' });
    expect(open[0]?.message).toContain('USD 6 a month at Twilio (EUR 5.4545');
    expect(await prisma.billingSmsQuote.count({ where: { country: 'CH' } })).toBe(0);
    // A USD 5.00 rental (EUR 4.5455, GBP 3.8636) is under all three, so each currency quotes again.
    rental.CH = '5.00';
    expect(await monthly('CH')).toMatchObject({ amount: '4.99', currency: 'EUR' });
    expect(await monthly('CH', 'sms-org-uk')).toMatchObject({ amount: '4.49', currency: 'GBP' });
    expect(await monthly('CH', 'sms-org-us')).toMatchObject({ amount: '5.49', currency: 'USD' });
    expect(await prisma.billingSmsPolicyAlert.count({ where: { subject: { startsWith: 'monthly:CH:' },
      resolvedAt: null } })).toBe(0);
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
    await prisma.billingStripeCustomer.create({ data: { ...base, scopeKey: `${smsIds.org}:sms:GBP` } });
    await expect(prisma.billingStripeCustomer.create({ data: { ...base, scopeKey: `${smsIds.org}:sms:CHF` } }))
      .rejects.toThrow();
  });

  it('keeps the price append-only and lets an operator row become current', async () => {
    await expect(prisma.billingSmsMonthlyPrice.update({ where: { id: 'sms-monthly-price-seed-eur' },
      data: { amount: '1.00' } })).rejects.toThrow();
    await prisma.billingSmsMonthlyPrice.create({ data: { amount: '5.99', currency: 'EUR', setBy: 'operator',
      setByUserId: smsIds.user, setAt: new Date(Date.now() + 1000) } });
    expect(await monthly('CZ')).toMatchObject({ amount: '5.99', currency: 'EUR' });
    expect(await monthly('CZ', 'sms-org-uk')).toMatchObject({ amount: '4.49', currency: 'GBP' });
    await expect(prisma.billingSmsMonthlyPrice.create({ data: { amount: '1.00', currency: 'CHF', setBy: 'seed' } }))
      .rejects.toThrow();
  });
});
