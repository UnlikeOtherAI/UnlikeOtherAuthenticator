export const llmBillingTariffRetirementMarkdown = `
## Retired tariff versions
Tariff versions are immutable and never deleted. A platform SUPERUSER retires one with
POST /internal/admin/billing/services/:serviceId/tariffs/:tariffId/retire and restores it with
POST …/restore; both are idempotent and answer 200 with the tariff. Every serialised tariff carries
retired_at (null while active) and retire_blocked_by: default, assignments, subscriptions (a live
Stripe or seat subscription) and contract_terms (a contract that is not terminated). Retire answers
409 BILLING_TARIFF_IN_USE while any applies. A retired version answers 409 BILLING_TARIFF_RETIRED
when made the default, assigned, or used for a Stripe checkout, and the Nessie regional
standard-<currency> lookups skip it. Past months and existing records keep resolving it. Every
serialised assignment carries effective_from_month (YYYY-MM): the month its newest term event starts.
`;
