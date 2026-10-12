export const llmBillingRegionMarkdown = `
## Organisation billing region
Every organisation has one billing region, UK, US or EUROPE, which sets the
currency of everything SMS (GBP, USD or EUR). It is chosen once by an
organisation owner or admin and never changes. POST /billing/v1/organisation-billing
returns billing_region: {region, currency} (both null until chosen),
{suggested_region, suggested_currency} to prefill the choice (from the
organisation's invoice billing country: GB → UK, the EU, EEA and CH → EUROPE,
anything else → US) and can_set (owner or admin, and no region yet).
POST /billing/v1/organisation-billing/region with the subject fields plus
region, the customer_lifecycle app key and a fresh X-UOA-Actor for that exact
endpoint chooses it and returns the same block. Repeating the same region is a
no-op; a different one answers 409 BILLING_REGION_IMMUTABLE; a non-manager gets
403 BILLING_ORG_MANAGER_REQUIRED. Until a region is chosen, SMS quotes, number
purchases and SMS top-ups answer 409 BILLING_REGION_REQUIRED: ask an owner or
admin to choose. AI usage stays USD for every region. Render the block; store
nothing.
`;
