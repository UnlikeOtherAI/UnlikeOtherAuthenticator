/** Org-only actor assertions are admitted only at these financial surfaces. */
export const ORGANISATION_FINANCIAL_ENDPOINTS = new Set<string>([
  '/billing/v1/organisation/capabilities','/billing/v1/organisation/overview',
  '/billing/v1/organisation/region',
  '/billing/v1/credits/top-up-checkout','/billing/v1/credits/auto-top-up/setup',
  '/billing/v1/credits/auto-top-up/update','/billing/v1/credits/auto-top-up/disable',
  '/billing/v1/credits/auto-top-up/recover','/billing/v1/credits/purchase-status',
  '/billing/v1/stripe/checkout-session','/billing/v1/stripe/portal-session',
  '/billing/v1/stripe/subscription-summary','/billing/v1/cancellation/preview','/billing/v1/cancellation/confirm',
  '/billing/v1/recurring-addons','/billing/v1/recurring-addons/checkout',
  '/billing/v1/recurring-addons/cancellation/preview','/billing/v1/recurring-addons/cancellation/confirm',
  '/billing/v1/cycles/list','/billing/v1/cycles/detail','/billing/v1/cycles/download',
  '/billing/v1/invoices/list','/billing/v1/invoices/detail','/billing/v1/invoices/download',
  '/billing/v1/organisation-billing/region',
]);
