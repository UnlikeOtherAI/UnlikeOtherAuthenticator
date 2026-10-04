export type BillingCustomerLocale = 'cs' | 'en-US' | 'en-GB' | 'de' | 'es' | 'fr' | 'it';

export const DEFAULT_BILLING_CUSTOMER_LOCALE: BillingCustomerLocale = 'en-US';

export type BillingLocaleCatalog<T> = Readonly<Record<BillingCustomerLocale, T>>;

export function billingLocale(locale?: BillingCustomerLocale): BillingCustomerLocale {
  return locale ?? DEFAULT_BILLING_CUSTOMER_LOCALE;
}

export function billingLocaleText<T>(
  catalog: BillingLocaleCatalog<T>,
  locale?: BillingCustomerLocale,
): T {
  return catalog[billingLocale(locale)];
}

export type BillingCopyValues = Readonly<Record<string, string | number>>;

export function formatBillingCopy(template: string, values: BillingCopyValues = {}): string {
  return Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

export type BillingCopyPluralForms = Readonly<{
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}>;

export function billingPluralCopy(
  forms: BillingCopyPluralForms,
  count: number,
  locale?: BillingCustomerLocale,
): string {
  const category = new Intl.PluralRules(billingLocale(locale)).select(count);
  const template = forms[category] ?? forms.other;
  return formatBillingCopy(template, { count });
}
