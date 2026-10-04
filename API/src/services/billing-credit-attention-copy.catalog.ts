import type { BillingCustomerLocale, BillingLocaleCatalog } from './billing-copy-locale.js';
import { billingLocaleText } from './billing-copy-locale.js';

export type BillingCreditAttentionCopy = Readonly<{
  fundingRequestLabel: string;
}>;

export const BILLING_CREDIT_ATTENTION_COPY = {
  cs: { fundingRequestLabel: 'Požádat o pomoc s platbou' },
  'en-US': { fundingRequestLabel: 'Ask for billing help' },
  'en-GB': { fundingRequestLabel: 'Ask for billing help' },
  de: { fundingRequestLabel: 'Hilfe zur Abrechnung anfordern' },
  es: { fundingRequestLabel: 'Pedir ayuda con la facturación' },
  fr: { fundingRequestLabel: 'Demander de l’aide sur la facturation' },
  it: { fundingRequestLabel: 'Chiedi assistenza per la fatturazione' },
} satisfies BillingLocaleCatalog<BillingCreditAttentionCopy>;

export function billingCreditAttentionCopy(
  locale?: BillingCustomerLocale,
): BillingCreditAttentionCopy {
  return billingLocaleText(BILLING_CREDIT_ATTENTION_COPY, locale);
}
