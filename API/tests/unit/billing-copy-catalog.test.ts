import { describe, expect, it } from 'vitest';

import { BILLING_ADDON_COPY } from '../../src/services/billing-addon-copy.catalog.js';
import {
  billingCreditCopy,
  billingLocalizedCreditDisplay,
  billingPendingCreditsLabel,
} from '../../src/services/billing-credit-copy.catalog.js';
import { BILLING_PAYMENT_COPY } from '../../src/services/billing-payment-copy.catalog.js';
import { BILLING_SUBSCRIPTION_COPY } from '../../src/services/billing-subscription-copy.catalog.js';
import type { BillingCustomerLocale } from '../../src/services/billing-copy-locale.js';

const locales: BillingCustomerLocale[] = ['cs', 'en-US', 'en-GB', 'de', 'es', 'fr', 'it'];

describe('customer billing copy catalogs', () => {
  it('provides complete non-empty copy for every supported locale', () => {
    for (const locale of locales) {
      expect(Object.values(BILLING_ADDON_COPY[locale]).every(Boolean)).toBe(true);
      expect(Object.values(BILLING_SUBSCRIPTION_COPY[locale]).every(Boolean)).toBe(true);
      expect(Object.values(BILLING_PAYMENT_COPY[locale]).every((state) => state.title && state.message)).toBe(true);
      expect(JSON.stringify(BILLING_ADDON_COPY[locale])).not.toContain('UOA');
    }
  });

  it('formats credit counts with the selected language while retaining the exact count', () => {
    expect(billingLocalizedCreditDisplay('1', 'cs')).toBe('1 kredit');
    expect(billingLocalizedCreditDisplay('2', 'cs')).toBe('2 kredity');
    expect(billingLocalizedCreditDisplay('5', 'cs')).toBe('5 kreditů');
    expect(billingLocalizedCreditDisplay('2', 'de')).toBe('2 Credits');
    expect(billingLocalizedCreditDisplay('0.000001', 'cs')).toBe('0,000001 kreditů');
    expect(billingLocalizedCreditDisplay('-0.000001', 'de')).toBe('-0,000001 Credits');
    expect(billingLocalizedCreditDisplay('9223372036854.775807', 'en-US'))
      .toBe('9,223,372,036,854.775807 credits');
    expect(billingPendingCreditsLabel(2, 'cs')).toBe('Čekají 2 dobití');
    expect(billingCreditCopy('cs').balanceLabel).toBe('Zbývající kredity');
  });

  it('keeps payment success language distinct from an unverified payment', () => {
    for (const locale of locales) {
      expect(BILLING_PAYMENT_COPY[locale].succeeded.message).not.toBe(
        BILLING_PAYMENT_COPY[locale].needs_review.message,
      );
      expect(BILLING_PAYMENT_COPY[locale].processing.message).not.toBe(
        BILLING_PAYMENT_COPY[locale].succeeded.message,
      );
    }
  });

  it('guides a failed payment back to the same payment without suggesting a new purchase', () => {
    for (const locale of locales) {
      const message = BILLING_PAYMENT_COPY[locale].failed.message;
      expect(message).toMatch(/payment|platbu|zahlung|pago|paiement|pagamento/i);
      expect(message).not.toMatch(/another purchase|another buy|další nákup|weiteren kauf|otra compra|autre achat|altro acquisto/i);
    }
    expect(BILLING_PAYMENT_COPY.cs.failed.message).toBe(
      'Zkontrolujte údaje o kartě nebo se obraťte na banku. Pak platbu zkuste znovu.',
    );
  });

  it('keeps customer billing actions in the selected language', () => {
    expect(BILLING_SUBSCRIPTION_COPY.cs.upgradeAction).toBe('Změnit tarif');
    expect(BILLING_SUBSCRIPTION_COPY.cs.managePaymentAction).toBe('Spravovat platby');
    expect(BILLING_SUBSCRIPTION_COPY.cs.cancelSubscriptionAction).toBe('Zrušit předplatné');
    expect(BILLING_SUBSCRIPTION_COPY.cs.organisationManagerMessage).not.toContain('Billing');
  });
});
