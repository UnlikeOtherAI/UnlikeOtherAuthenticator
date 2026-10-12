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

## Credits bought in the region currency
Credits stay one USD-denominated unit (1,000 per USD). An organisation in the UK
or Europe buys them in GBP or EUR. Send x-uoa-billing-credits-protocol: 2.1.0 on
POST /billing/v1/credits to receive the one-time offers in the region currency
(USD until a region is chosen; older protocol versions keep the USD offers, which
stay purchasable). A GBP or EUR offer carries credit_rate {currency,
usd_per_unit, source, as_of, display}; its credits_received is what today's rate
buys. The exact credits are fixed when POST /billing/v1/credits/top-up-checkout
creates the checkout (payment times Stripe's live base rate, rounded down to
whole credits, no buffer) and granted unchanged when the payment succeeds. While
no rate can be read those offers are left out and the checkout answers 503
BILLING_CREDIT_FX_RATE_UNAVAILABLE; try again later. Automatic top-up stays USD
for now.
`;
