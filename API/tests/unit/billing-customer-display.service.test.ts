import { describe, expect, it } from 'vitest';

import { billingCycleDetailV2ConformanceFixture,
  billingCustomerInvoiceDetailV1ConformanceFixture } from '../../src/contracts/billing-statement-v1.js';
import { localizeBillingCycleDetail } from '../../src/services/billing-cycle-display.service.js';
import { localizeCustomerInvoiceDetail } from '../../src/services/billing-customer-invoice-display.service.js';
import { exactMoney } from '../../src/services/billing-money.service.js';

describe('customer read display localization', () => {
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
