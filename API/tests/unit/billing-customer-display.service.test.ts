import { describe, expect, it } from 'vitest';

import { billingCycleDetailV2ConformanceFixture,
  billingCustomerInvoiceDetailV1ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import { localizeBillingCycleDetail } from '../../src/services/billing-cycle-display.service.js';
import { localizeCustomerInvoiceDetail } from '../../src/services/billing-customer-invoice-display.service.js';
import { exactMoney } from '../../src/services/billing-money.service.js';
import { billingCreditAmount } from '../../src/services/billing-credit-display.service.js';
import { billingCreditFundingCopy } from '../../src/services/billing-credit-funding-copy.catalog.js';
import { billingCreditAutoTopUpCopy } from '../../src/services/billing-credit-auto-top-up-copy.catalog.js';
import { billingOrganisationCopy } from '../../src/services/billing-organisation-copy.catalog.js';
import { localizeOrganisationAccruedBill } from '../../src/services/billing-financial-display.service.js';
import { organisationAccrualTotals } from '../../src/services/billing-organisation-accrual-totals.service.js';

describe('customer read display localization', () => {
  it('normalizes old display text without changing amounts or the frozen source, including the default locale',()=>{
    const source=structuredClone(billingCustomerInvoiceDetailV1ConformanceFixture);
    source.charges[0]!.amount={amount:'-13',amount_minor:'-1300',currency:'USD',display:'US$-13'};
    source.totals.outstanding={amount:'0.6',amount_minor:'60',currency:'USD',display:'$0.6'};
    const before=JSON.stringify(source),result=localizeCustomerInvoiceDetail(source);
    expect(result.charges[0]?.amount).toEqual({...source.charges[0]!.amount,display:'-$13.00'});
    expect(result.totals.outstanding).toEqual({...source.totals.outstanding,display:'$0.60'});
    expect(JSON.stringify(source)).toBe(before);
    expect(billingCreditAmount(123450000000n,'cs').display).toBe('123 450 kreditů');
    expect(billingCreditAmount(-500000n,'de').display).toBe('-0,5 Credits');
  });
  it('authors organisation funding copy and bill displays in all seven locales',()=>{
    const titles=['Doplnit kredity organizace','Add organisation credits','Add organisation credits','Organisationsguthaben aufladen',
      'Añadir créditos a la organización','Ajouter des crédits à l’organisation','Aggiungi crediti all’organizzazione'];
    const locales=['cs','en-US','en-GB','de','es','fr','it'] as const;
    const bill={as_of:'2028-02-08T00:00:00.000Z',period:{month:'2028-02',starts_at:'2028-02-01T00:00:00.000Z',ends_at:'2028-03-01T00:00:00.000Z'},
      ...organisationAccrualTotals([{id:'usage',product:'nessie',label:'Nessie',kind:'usage',currency:'USD',amountMinor:1300n},
        {id:'credit',product:'nessie',label:'Credits',kind:'prepaid_credit',currency:'USD',amountMinor:-1300n}],new Map(),[])};
    const before=JSON.stringify(bill);
    for(const [index,locale] of locales.entries()){
      expect(billingCreditFundingCopy(locale).title).toBe(titles[index]);
      expect(billingCreditAutoTopUpCopy(locale).disabledDescription).not.toMatch(/team|tým|equipo|équipe/i);
      expect(billingOrganisationCopy(locale).confirmed).not.toContain('UOA');
      const result=localizeOrganisationAccruedBill(bill,locale);
      expect(result.lines[1]?.amount.amount_minor).toBe('-1300');expect(result.totals[0]?.total_due.amount_minor).toBe('0');
      expect(result.lines[1]?.amount.display).toBe(exactMoney('-13','USD',locale).display);
      expect(result.totals[0]?.gross_total.display).toBe(exactMoney('13','USD',locale).display);
    }
    expect(JSON.stringify(bill)).toBe(before);
  });
  it('retains microcredit-equivalent precision, large integers and the sign below one', () => {
    expect(exactMoney('0.000000001', 'USD', 'cs')).toMatchObject({
      amount: '0.000000001', display: '0,000000001\u00a0US$',
    });
    expect(exactMoney('-0.000001', 'EUR', 'de').display).toBe('-0,000001\u00a0€');
    expect(exactMoney('9223372036854.775807', 'USD', 'en-US').display)
      .toBe('$9,223,372,036,854.775807');
    expect(exactMoney('1.234', 'KWD', 'cs').amount).toBe('1.234');
  });

  it('translates cycle labels from structural facts without editing the frozen source', () => {
    const source = structuredClone(billingCycleDetailV2ConformanceFixture);
    const before = JSON.stringify(source);
    const cs = localizeBillingCycleDetail(source, 'cs');
    expect(cs.subscription_lines[0]?.label).toBe('Měsíční místa');
    expect(cs.usage_lines[0]?.label).toBe('Spotřeba podle využití');
    expect(cs.subscription_lines[0]?.id).toBe(source.subscription_lines[0]?.id);
    expect(cs.subscription_lines[0]?.customer_charge.amount)
      .toBe(source.subscription_lines[0]?.customer_charge.amount);
    expect(cs.documents.map((document) => document.download_action))
      .toEqual(source.documents.map((document) => document.download_action));
    expect(cs.adjustments.map((item) => item.reason)).toEqual(source.adjustments.map((item) => item.reason));
    expect(JSON.stringify(source)).toBe(before);
  });

  it('keeps authored invoice names, document identity and every numeric fact', () => {
    const source = structuredClone(billingCustomerInvoiceDetailV1ConformanceFixture);
    source.charges[0]!.label = 'Customer-authored plan name';
    const before = JSON.stringify(source);
    const de = localizeCustomerInvoiceDetail(source, 'de');
    expect(de.charges[0]?.label).toBe('Customer-authored plan name');
    expect(de.document).toEqual(source.document);
    expect(de.charges[0]?.amount.amount_minor).toBe(source.charges[0]?.amount.amount_minor);
    expect(de.totals.total_paid.display).toContain(',');
    expect(JSON.stringify(source)).toBe(before);
  });
});
