import {
  BILLING_CUSTOMER_LOCALES,
  BILLING_LOCALE_HEADER,
  BILLING_PRESENTATION_HEADER,
  BILLING_PRESENTATION_VERSION,
  type BillingCustomerLocale,
} from '../../contracts/billing-statement-v1.js';
import { AppError } from '../../utils/errors.js';

/** Locale affects display only; it never changes the signed subject or action body. */
export function readBillingPresentation(headers: Record<string, string | string[] | undefined>): {
  enabled: boolean;
  locale: BillingCustomerLocale;
} {
  const version = headers[BILLING_PRESENTATION_HEADER];
  const locale = headers[BILLING_LOCALE_HEADER];
  if (version === undefined && locale === undefined) return { enabled: false, locale: 'en-US' };
  if (version !== BILLING_PRESENTATION_VERSION) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_PRESENTATION_VERSION_UNSUPPORTED');
  }
  if (locale === undefined) return { enabled: true, locale: 'en-US' };
  if (typeof locale !== 'string' || !BILLING_CUSTOMER_LOCALES.some((item) => item === locale)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_LOCALE_UNSUPPORTED');
  }
  return { enabled: true, locale: locale as BillingCustomerLocale };
}
