export const llmBillingSmsMarkdown = `
## Mobile-number and SMS pricing
POST /billing/v1/sms/quotes with the product ENTITLEMENT app key and a fresh
X-UOA-Actor signed for this exact endpoint. Body contains product,
organisation_id, team_id, user_id, country, number_type (mobile, local, national or toll-free), direction,
destination (outbound E.164 or null), carrier:null, mcc:null and mnc:null.
UOA verifies outbound country through Basic Lookup and uses the conservative
maximum destination-carrier price from the specified sender class. Return only opaque id, final exact amount and its
currency, expiry, rate_basis and scope. Render the currency the quote carries.
A mobile monthly quote in provider-markup mode uses Twilio's current mobile rental for
the number's country plus the configured number markup, converted to EUR, GBP or
USD according to the organisation's billing region. 409 BILLING_REGION_REQUIRED
means an owner or admin must choose the region first. Legacy flat pricing can
return 409 BILLING_SMS_MONTHLY_PRICE_BELOW_COST when the rental reaches the flat
price. Non-mobile rentals require a separately configured operator price for their class and currency. Message quotes are USD. Missing provider
or accepted dated currency policy returns unavailable; no sample quote exists.
POST /billing/v1/sms/quotes/verify with the same scope plus quote_id and a fresh
actor for that exact verification endpoint. It refuses changed scope or expiry.
Monthly quote expiry is a display/admission limit, not cancellation of already
accepted paid terms for an exact number resource.
Registered prepaid routes require fresh customer authority for funding and grant
consent, ENTITLEMENT for human reserve, and SMS_RUNTIME for physical dispatch and
recovery. Inbound receipt requests include original organisation_id and team_id.
Missing revoke/release/standing retirement return strict minimal fenced proofs.
Customer SMS quotes include accepted additional-fee bounds and are maximum prices
per segment; actual verified settlement may be lower. No unknown charge is freed
or repeated merely because delivery failed.
`;
