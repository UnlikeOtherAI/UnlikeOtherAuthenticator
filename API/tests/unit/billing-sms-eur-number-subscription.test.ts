import { BillingAssignmentScope, BillingRecurringAddonEntitlementScope } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ensureRecurringAddonStripeCatalog } from '../../src/services/billing-recurring-addon-catalog.service.js';
import { recurringAddonScope, smsNumberCustomerScopeKey } from '../../src/services/billing-recurring-addon-scope.service.js';

const subject = { product: 'nessie', organisationId: 'org_1', teamId: 'team_1', userId: 'user_1' };
const account = { id: 'stripe_account', stripeAccountId: 'acct_test', livemode: false };

describe('SMS number subscriptions in the quote currency', () => {
  it('bill through a Stripe Customer of their own per organisation and currency', () => {
    const org = BillingRecurringAddonEntitlementScope.ORGANISATION;
    expect(recurringAddonScope(org, subject, { resourceKind: 'sms_mobile_number', currency: 'EUR' })).toMatchObject({
      scopeKey: 'org_1', customerScope: BillingAssignmentScope.ORGANISATION, customerScopeKey: 'org_1:sms:EUR' });
    expect(recurringAddonScope(org, subject, { resourceKind: 'sms_mobile_number', currency: 'USD' }).customerScopeKey)
      .toBe('org_1:sms:USD');
    // Every other organisation subscription keeps the organisation's own Customer.
    expect(recurringAddonScope(org, subject, { resourceKind: null, currency: 'USD' }).customerScopeKey).toBe('org_1');
    expect(recurringAddonScope(org, subject).customerScopeKey).toBe('org_1');
    expect(() => smsNumberCustomerScopeKey('org_1', 'GBP')).toThrow('BILLING_RECURRING_ADDON_UNAVAILABLE');
  });

  it('creates the Stripe monthly price in EUR at the exact minor amount', async () => {
    const offer = { id: 'offer_1', serviceId: 'service_1', key: 'sms-key', version: 1, name: 'Mobile number +447463595266',
      description: 'Monthly mobile phone number service.', monthlyAmountMinor: 499n, currency: 'EUR' };
    const catalog = { id: 'catalog_1', accountId: account.id, serviceId: 'service_1', offerId: 'offer_1',
      currency: 'EUR', monthlyAmountMinor: 499n, stripeLookupKey: 'sms-key:1:stripe_account',
      stripeProductId: null as string | null, stripePriceId: null as string | null };
    const price = { id: 'price_1', object: 'price', livemode: false, active: true, product: 'prod_1',
      lookup_key: catalog.stripeLookupKey, currency: 'eur', type: 'recurring', unit_amount: 499,
      unit_amount_decimal: '499', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null },
      metadata: {} as Record<string, string> };
    const product = { id: 'prod_1', object: 'product', livemode: false, active: true, deleted: undefined,
      metadata: {} as Record<string, string> };
    const stripe = {
      products: { create: vi.fn(async (input: { metadata: Record<string, string> }) => {
        product.metadata = input.metadata; return product; }), retrieve: vi.fn(async () => product) },
      prices: { create: vi.fn(async (input: { metadata: Record<string, string> }) => {
        price.metadata = input.metadata; return price; }), retrieve: vi.fn(async () => price) },
    };
    const prisma = { billingRecurringAddonCatalog: { update: vi.fn(async ({ data }) => Object.assign(catalog, data)) } };
    await ensureRecurringAddonStripeCatalog({ catalog: catalog as never, offer: offer as never,
      serviceIdentifier: 'nessie', serviceName: 'Nessie', account, stripe: stripe as never }, { prisma: prisma as never });
    expect(stripe.prices.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'eur', unit_amount: 499,
      recurring: { interval: 'month', usage_type: 'licensed' } }), expect.anything());
    expect(catalog).toMatchObject({ stripeProductId: 'prod_1', stripePriceId: 'price_1' });
  });
});
