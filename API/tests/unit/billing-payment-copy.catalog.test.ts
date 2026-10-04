import { describe, expect, it } from 'vitest';

import { billingPaymentCopy } from '../../src/services/billing-payment-copy.catalog.js';

describe('localized credit payment state copy', () => {
  it.each([
    ['cs', 'Platba je potvrzená. Kredity byly připsány.'],
    ['en-US', 'Your payment is confirmed. Credits were added.'],
    ['en-GB', 'Your payment is confirmed. Credits were added.'],
    ['de', 'Ihre Zahlung ist bestätigt. Credits wurden gutgeschrieben.'],
    ['es', 'El pago está confirmado. Los créditos se añadieron.'],
    ['fr', 'Votre paiement est confirmé. Les crédits ont été ajoutés.'],
    ['it', 'Il pagamento è confermato. I crediti sono stati aggiunti.'],
  ] as const)('reports the confirmed result in %s', (locale, message) => {
    expect(billingPaymentCopy('succeeded', locale).message).toBe(message);
  });

  it.each(['cs', 'en-US', 'en-GB', 'de', 'es', 'fr', 'it'] as const)(
    'uses ordinary payment-page wording in %s',
    (locale) => {
      expect(billingPaymentCopy('open', locale).message.toLowerCase()).not.toContain('checkout');
      expect(billingPaymentCopy('requires_action', locale).message.toLowerCase()).not.toContain(
        'checkout',
      );
      expect(billingPaymentCopy('expired', locale).title.toLowerCase()).not.toContain('checkout');
    },
  );
});
