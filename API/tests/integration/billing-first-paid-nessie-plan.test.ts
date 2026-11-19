import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveCurrentBillingTariff } from '../../src/services/billing-current-tariff.service.js';
import { readNessieSeatAccess } from '../../src/services/billing-nessie-seat-access.service.js';
import { billingRegionView } from '../../src/services/billing-organisation-region.service.js';
import { persistStripePaymentInvoice } from '../../src/services/billing-stripe-payment-invoice-source.service.js';
import { syncBaseStripeSubscription } from '../../src/services/billing-stripe-subscription-projection.service.js';
import { appendTariffTermEvent, nextUtcBillingMonth, utcBillingMonth } from '../../src/services/billing-tariff-history.service.js';
import { createBillingTariffVersion } from '../../src/services/billing-tariff.service.js';
import { migrationRoleFixture } from '../helpers/invitation-migration-role.js';
import { captureTestOrganisationFinancialBinding } from '../helpers/organisation-financial-binding.js';

const migration = '20261119200000_first_paid_nessie_plan';

describe.skipIf(!process.env.DATABASE_URL)('first paid Nessie plan', () => {
  let fixture: Awaited<ReturnType<typeof migrationRoleFixture>>;
  let db: PrismaClient;
  let billing: PrismaClient;
  beforeAll(async () => {
    fixture = await migrationRoleFixture();
    // Production's seat guards and their callees all belong to uoa_admin.
    await fixture.admin.query(`ALTER ROLE "${fixture.name}" SET role TO uoa_admin`);
    await fixture.copyRemaining(migration);
    expect(await fixture.deploy()).toBe(0);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('schema', fixture.name);
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    billing = new PrismaClient({ datasources: { db: { url: fixture.databaseUrl } } });
  }, 180_000);
  afterAll(async () => {
    await billing?.$disconnect();
    await db?.$disconnect();
    await fixture?.cleanup();
    vi.unstubAllEnvs();
  });

  it('repairs the later region, locks new payments and honors a future operator assignment', async () => {
    const now = new Date();
    const month = utcBillingMonth(now);
    const actor = { email: 'operator@example.test' };
    const service = await db.billingService.create({ data: { identifier: 'nessie', name: 'Nessie', tariffHistoryFromMonth: month } });
    const standard = (currency: string, amount: string) => createBillingTariffVersion({ serviceId: service.id, actor,
      setAsDefault: currency === 'USD', tariff: { key: 'standard-' + currency.toLowerCase(), name: currency, currency, usageCurrency: 'USD',
        mode: 'standard', collectionMode: 'stripe', monthlyAmountMinor: amount, monthlyChargeBasis: 'per_seat',
        seatPolicy: 'automatic', seatChargeTiming: 'prorated', usagePaymentMode: 'prepaid' } }, { prisma: db });
    const usd = await standard('USD', '399');
    await standard('EUR', '299');
    const free = await createBillingTariffVersion({ serviceId: service.id, actor, setAsDefault: false,
      tariff: { key: 'free', name: 'Free', currency: 'USD', mode: 'free', monthlyAmountMinor: '0', collectionMode: 'none' } }, { prisma: db });
    await db.$transaction(tx => appendTariffTermEvent(tx, { serviceId: service.id, source: 'SERVICE_DEFAULT',
      scopeKey: service.id, effectiveFromMonth: month, tariffId: usd.id, reason: 'initial-default' }));

    const owner = await db.user.create({ data: { email: 'owner@example.test', userKey: 'plan-owner' }, select: { id: true } });
    const account = await db.billingStripeAccount.create({ data: { stripeAccountId: 'acct_PlanLock', livemode: true } });
    const catalog = await db.billingStripeCatalog.create({ data: { accountId: account.id, serviceId: service.id, currency: 'USD',
      meterEventName: 'plan_usage', stripeProductId: 'prod_seat', stripeMeterId: 'mtr_seat', stripeUsagePriceId: 'price_usage' } });
    await db.billingStripeTariffPrice.create({ data: { accountId: account.id, catalogId: catalog.id, tariffId: usd.id,
      monthlyAmountMinor: 399n, stripeMonthlyPriceId: 'price_seat' } });

    async function buyer(slug: string) {
      const org = await db.organisation.create({ data: { slug, name: slug, ownerId: owner.id, domain: slug + '.example' } });
      const team = await db.team.create({ data: { orgId: org.id, name: 'Team', slug: 'team' } });
      await db.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
      const key = await db.billingAppKey.create({ data: { serviceId: service.id, purpose: 'CUSTOMER_LIFECYCLE', name: slug,
        keyPrefix: slug, secretDigest: slug, actorIssuer: 'https://' + org.domain, actorAudience: 'https://identity.example',
        actorKeyId: 'test', actorPublicJwk: {}, checkoutReturnOrigins: ['https://' + org.domain] } });
      const { billingModeRevision, billingScopeEpoch } = await captureTestOrganisationFinancialBinding(db, org.id, account);
      const customer = await db.billingStripeCustomer.create({ data: { accountId: account.id, orgId: org.id,
        scope: 'ORGANISATION', scopeKey: org.id, stripeCustomerId: 'cus_' + slug } });
      const checkout = () => db.billingStripeCheckoutSession.create({ data: { accountId: account.id,
        billingModeRevision, billingScopeEpoch, billingModeTeamId: team.id, appKeyId: key.id,
        customerId: customer.id, tariffId: usd.id, serviceId: service.id, tariffSource: 'SERVICE_DEFAULT', orgId: org.id,
        scope: 'ORGANISATION', scopeKey: org.id, actorJti: slug, requestedByUserId: owner.id, status: 'complete',
        successUrlDigest: 'a'.repeat(64), cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: now } });
      const chooseEuro = () => db.billingOrganisationRegion.create({ data: { orgId: org.id, region: 'EUROPE',
        currency: 'EUR', setByUserId: owner.id, setAt: new Date(now.getTime() + 3000) } });
      const scope = { serviceId: service.id, organisationId: org.id, teamId: team.id };
      const access = () => billing.$transaction(tx => readNessieSeatAccess(tx, scope, now, 'projection'));
      async function subscribe(checkoutId: string) {
        const start = Math.floor(now.getTime() / 1000) - 60;
        const period = { current_period_start: start, current_period_end: start + 30 * 86400 };
        await db.$transaction(tx => syncBaseStripeSubscription(tx, { id: 'sub_' + slug, customer: customer.stripeCustomerId,
          status: 'active', livemode: true, billing_mode: { type: 'classic' }, cancel_at_period_end: false,
          items: { data: [{ ...period, id: 'si_' + slug, quantity: 1, price: { id: 'price_seat', currency: 'usd', unit_amount: 399,
            recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } },
            { ...period, id: 'si_usage_' + slug, price: { id: 'price_usage', recurring: { usage_type: 'metered' } } }] },
          metadata: { uoa_checkout_id: checkoutId, uoa_service_id: service.id, uoa_tariff_id: usd.id,
            uoa_scope_key: org.id, uoa_stripe_account_id: account.stripeAccountId, uoa_stripe_mode: 'live' } } as never, account));
        const sub = await db.billingStripeSubscription.findFirstOrThrow({ where: { checkoutId } });
        return () => billing.$transaction(tx => persistStripePaymentInvoice(tx, {
          facts: { accountId: account.id, subscriptionId: sub.id, livemode: true, stripeInvoiceId: 'in_' + slug,
            stripeCustomerId: customer.stripeCustomerId, stripePaymentIntentIds: ['pi_' + slug],
            paymentEvidence: [{ invoice_payment_id: 'inpay_' + slug, payment_intent_id: 'pi_' + slug,
              charge_id: 'ch_' + slug, amount_minor: '399', paid_at: now.toISOString() }],
            orgId: org.id, teamId: null, paidAt: now, currency: 'USD', grossAmountMinor: 399n,
            taxAmountMinor: 0n, creditAmountMinor: 0n, dueAmountMinor: 399n, paidAmountMinor: 399n },
          lines: [{ stripeLineId: 'il_' + slug, serviceId: service.id, serviceIdentifier: 'nessie', billingMonth: utcBillingMonth(new Date(start * 1000)),
            label: 'Seat subscription', subscriptionMinor: 399n, usageMinor: 0n, taxMinor: 0n, creditMinor: 0n,
            grossMinor: 399n, dueMinor: 399n, seatPeriod: { subscriptionId: sub.id, startsAt: new Date(start * 1000),
              endsAt: new Date(period.current_period_end * 1000), quantity: 1 } }],
          sourceDigest: 'c'.repeat(64), invoice: { billing_reason: 'subscription_create', status: 'paid',
            total: 399, amount_due: 399, amount_paid: 399, amount_remaining: 0, ending_balance: 0 },
        } as never));
      }
      return { org, scope, checkout, chooseEuro, subscribe, access };
    }

    const old = await buyer('existing');
    const collect = await old.subscribe((await old.checkout()).id);
    await collect();
    await old.chooseEuro();
    const nextMonth = nextUtcBillingMonth(now);
    await db.$transaction(tx => appendTariffTermEvent(tx, { serviceId: service.id, source: 'ORGANISATION',
      scopeKey: old.org.id, effectiveFromMonth: nextMonth, tariffId: free.id, reason: 'assignment-changed' }));
    const paidScope = () => db.$queryRaw<Array<{ tariff_id: string }>>`
      SELECT tariff_id FROM billing_nessie_paid_seat_scope(${old.org.id}, ${old.scope.teamId})`;
    expect((await paidScope())[0]?.tariff_id).not.toBe(usd.id);
    await fixture.copyMigration(migration);
    expect(await fixture.deploy()).toBe(0);
    expect(await billingRegionView(old.org.id, true, db)).toMatchObject({ region: 'US', currency: 'USD', can_set: false });
    expect(await paidScope()).toEqual([{ tariff_id: usd.id }]);
    expect(await old.access()).toMatchObject({ allowed: true, status: 'paid' });
    expect((await resolveCurrentBillingTariff(db, { ...old.scope, billingMonth: nextMonth }, 'nessie')).tariff.id).toBe(free.id);
    expect(await db.billingStripePaymentInvoice.count()).toBe(1);

    const fresh = await buyer('newbuyer');
    const acceptCash = await fresh.subscribe((await fresh.checkout()).id);
    await expect(fresh.chooseEuro()).rejects.toThrow('STRIPE_TARIFF_PINNED');
    expect(await billingRegionView(fresh.org.id, true, db)).toMatchObject({ region: null, can_set: true });
    expect((await fresh.access()).allowed).toBe(false);
    await acceptCash();
    expect(await billingRegionView(fresh.org.id, true, db)).toMatchObject({ region: 'US', currency: 'USD', can_set: false });
    expect(await fresh.access()).toMatchObject({ allowed: true, status: 'paid' });
    await expect(fresh.chooseEuro()).rejects.toThrow('BILLING_REGION_IMMUTABLE');

    const earlierChoice = await buyer('firstchoice');
    await earlierChoice.chooseEuro();
    await expect(earlierChoice.checkout()).rejects.toThrow('BILLING_CONTEXT_STALE');
    expect(await db.billingStripePaymentInvoice.count()).toBe(2);
  }, 120_000);
});
