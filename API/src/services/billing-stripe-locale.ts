import { BILLING_CUSTOMER_LOCALES, type BillingCustomerLocale } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';

/** Stripe names US English `en`; every other supported tag is already exact. */
export function stripeBillingLocale(locale: BillingCustomerLocale): Exclude<BillingCustomerLocale, 'en-US'> | 'en' {
  return locale === 'en-US' ? 'en' : locale;
}

/** Legacy attempts omit locale; later retries keep the value saved at creation. */
export function stripeCheckoutLocale(locale: string | null | undefined) {
  if (locale == null) return {};
  const supported = BILLING_CUSTOMER_LOCALES.find((value) => value === locale);
  if (!supported) throw new AppError('INTERNAL', 500, 'BILLING_CHECKOUT_LOCALE_INVALID');
  return { locale: stripeBillingLocale(supported) };
}
