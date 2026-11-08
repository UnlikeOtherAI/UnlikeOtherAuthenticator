import { describe,expect,it,vi } from 'vitest';
import { organisationSubscriptionCustomerScopeKey as key } from '../../src/services/billing-subscription-customer-scope.service.js';
import { subscriptionPortalCopy } from '../../src/services/billing-subscription-portal-copy.service.js';
import { recurringAddonScope,smsNumberCustomerScopeKey } from '../../src/services/billing-recurring-addon-scope.service.js';
import type { BillingCustomerLocale } from '../../src/services/billing-copy-locale.js';
import { assertStripeUsageSubscription } from '../../src/services/billing-stripe-usage-validation.service.js';
import { subscriptionFixture } from './billing-stripe-usage.test-fixtures.js';

describe('one organisation payer with currency-specific subscription customers',()=>{
  const subject={product:'nessie',organisationId:'org',teamId:'team',userId:'user'};
  it('separates provider currency and funding/SMS keys while keeping entitlement and payer scopes exact',()=>{
    expect(['USD','EUR','GBP'].map(currency=>key('org',currency))).toEqual(['org:billing:USD','org:billing:EUR','org:billing:GBP']);
    const addon=recurringAddonScope('TEAM',subject,{resourceKind:null,currency:'USD'});
    expect(addon).toMatchObject({scope:'TEAM',scopeKey:'org:team',customerScope:'ORGANISATION',customerTeamId:null,
      customerScopeKey:'org:billing:USD'});
    expect(key('org','EUR')).not.toBe(addon.customerScopeKey);
    expect(smsNumberCustomerScopeKey('org','USD')).toBe('org:sms:USD');
    expect(()=>key('org','usd')).toThrow('STRIPE_SUBSCRIPTION_CURRENCY_INVALID');
    expect(()=>key('org','USD:other')).toThrow('STRIPE_SUBSCRIPTION_CURRENCY_INVALID');
  });
  it.each(['cs','en-US','en-GB','de','es','fr','it'] as BillingCustomerLocale[])
    ('names the captured subscription and currency in %s without claiming to manage funding',async locale=>{
      const findFirst=vi.fn().mockResolvedValue({scope:'ORGANISATION',orgId:'org',accountId:'live',tariff:{currency:'EUR'},service:{name:'Nessie'},
        customer:{scope:'ORGANISATION',teamId:null,orgId:'org',accountId:'live',stripeCustomerId:'cus_captured_eur'}});
      const copy=await subscriptionPortalCopy({subscriptionId:'sub_captured',organisationId:'org',serviceId:'nessie',locale},
        {billingStripeSubscription:{findFirst}} as never);
      expect(copy.label).toContain('Nessie');expect(copy.label).toContain('EUR');expect(copy.description).toContain('EUR');
      expect(copy.description.length).toBeGreaterThan(80);
      expect(findFirst.mock.calls[0]![0].where).toEqual({id:'sub_captured',orgId:'org',serviceId:'nessie'});
    });
  it('refuses a mismatched captured customer instead of presenting a misleading Portal',async()=>{
    await expect(subscriptionPortalCopy({subscriptionId:'sub',organisationId:'org',serviceId:'nessie'},
      {billingStripeSubscription:{findFirst:async()=>({scope:'ORGANISATION',orgId:'org',accountId:'live',
        customer:{scope:'ORGANISATION',teamId:null,accountId:'test',orgId:'org',stripeCustomerId:'cus_test'}})}} as never))
      .rejects.toThrow('STRIPE_SUBSCRIPTION_PORTAL_BINDING_UNPROVEN');
  });
  it('admits the exact currency customer for captured usage and retains strict historical TEAM bindings',()=>{
    const source=subscriptionFixture();expect(()=>assertStripeUsageSubscription(source as never)).not.toThrow();
    const org={...source,scope:'ORGANISATION',scopeKey:'org_1',teamId:null,
      customer:{...source.customer,scope:'ORGANISATION',scopeKey:key('org_1','USD'),teamId:null}};
    expect(()=>assertStripeUsageSubscription(org as never)).not.toThrow();
    expect(()=>assertStripeUsageSubscription({...org,customer:{...org.customer,scopeKey:key('org_1','EUR')}} as never))
      .toThrow('STRIPE_SUBSCRIPTION_NOT_METERABLE');
    expect(()=>assertStripeUsageSubscription({...source,customer:{...source.customer,scopeKey:key('org_1','USD')}} as never))
      .toThrow('STRIPE_SUBSCRIPTION_NOT_METERABLE');
  });
});
