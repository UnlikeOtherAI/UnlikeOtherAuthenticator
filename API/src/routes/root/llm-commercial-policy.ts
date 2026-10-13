export const llmCommercialPolicyMarkdown = `
## Company commercial policy
UOA owns identity, invitations, membership, subscriptions, prices, capacity and payment evidence.
Read /billing/v1/seats with lifecycle key and exact actor to show current company agreements, separately effective usage terms and only compatible operator-published Standard offers. Relay the exact accepted offer action to /billing/v1/seats/checkout; never assign a tariff or infer paid standing from redirect. Completion establishes prospective seats. Existing accepted/metered usage changes next UTC month; genuinely first usage terms start at observed acceptance and cannot authorize an earlier dispatch timestamp. Both responses are private, no-store.
Tariff usage_currency values provider/credit costs independently of monthly_subscription.currency. New regional Standard versions explicitly retain USD prepaid usage. Historical currency, balances and invoices never change; cross-currency collectible/uncovered usage requires reconciliation, never relabelling or guessed FX.
Use POST /billing/v1/product-entitlement with the ENTITLEMENT key and a fresh exact-endpoint RS256 actor.
Members receive only functional access/history/admission/storage facts. Company managers additionally receive commercial standing/deadlines.
An unattended consumer uses a separate commercial_worker app key, no actor, and POST /billing/v1/product-entitlement/background.
Each request checks exact enrolled company/product, active source, revocation and current subjects. Cache only in memory, keyed by company/product/person/team through valid_until.
An org-only background response does not admit a person. Team subscriptions never license an entire company.
POST /billing/v1/storage/observations appends durable revision plus measurement_version and blob/database bytes. It never creates byte-meter invoices.
POST /billing/v1/storage/ensure-capacity requests a desired minimum under an immutable operation id. Whole decimal TB expansion requires separate accepted storage consent.
Setup/no mandate blocks allocation; confirmed seat/storage failure permits existing pending capacity during the original24 weekday hours, pausing Saturday/Sunday in company timezone.
Read POST /billing/v1/storage through the lifecycle key/actor to show exact price and consent; POST /mandate only after acceptance. Credit top-up consent is insufficient.
Initial Stripe incomplete_expired does not resolve payment failure. POST /storage/recover replaces only a freshly proven terminal unpaid attempt; original grace remains.
Poll POST /billing/v1/commercial-events and acknowledge successful exact event/recipient/channel transport with /acknowledge. External email acknowledgements are rejected; UOA owns email.
Phone grace is seven calendar days, requiring three accepted warning stages and at least24hours after final-warning acceptance.
POST /commercial-events/phone-release immediately before releasing the exact returned provider IDs; reject false/stale/mismatched receipts.
After provider release use the existing idempotent /billing/v1/sms/numbers/end, which verifies provider absence and terminates service while retaining unpaid financial history.
The strict schemas are /schemas/product-entitlement-v1.json and /schemas/commercial-policy-v1.json; all new human endpoints require exact audience even during legacy warn mode.
`;
