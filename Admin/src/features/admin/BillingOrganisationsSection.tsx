import type { BillingService } from '../../schemas/billing';

/**
 * Admin → Billing → Organisations: pick an organisation, then edit its own tariff and each
 * team's, per product. Contract: Docs/plans/2026-11-16-billing-admin-cleanup.md §4.
 */
export function BillingOrganisationsSection(_props: {
  services: BillingService[];
  servicesError: boolean;
  servicesLoading: boolean;
}) {
  return null;
}
