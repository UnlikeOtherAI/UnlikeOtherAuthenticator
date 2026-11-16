export const llmBillingPeriodsMarkdown = `
## Billing time periods
Commercial periods are operator settings, per product, in Billing → the product
→ Time periods (GET/PUT /internal/admin/billing/services/:serviceId/period-settings,
admin-domain SUPERUSER). seat_trial_hours is the free seat trial of a new or
newly paid Nessie organisation (default 168, one week). seat_renewal_grace_hours
is how many Monday–Friday hours access continues after a failed seat renewal
(default 24). A change applies to periods that start afterwards; a running trial
or grace keeps the deadline it was given. Products never store either number:
POST /billing/v1/organisation/access returns the deadline to show.
`;
