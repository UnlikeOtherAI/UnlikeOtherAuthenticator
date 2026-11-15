export const llmBillingBrowserMarkdown = `
## Prepaid cloud browser minutes
Browserbase usage uses the dedicated BROWSER_RUNTIME product app key. Tariff and
reserve calls require a fresh X-UOA-Actor for the exact endpoint and selected
team. Reserve live prepaid credits before provider creation, then claim once.
Only can_dispatch:true authorises creation. Persist a one-shot dispatch marker
and provider metadata; retries must recover the original session, never create
another. Read, claim, receipt and release are server-only runtime operations.
The terminal receipt binds provider project/session, timestamps and proxy bytes.
UOA freezes the original payer, policy and budget, and settles the liability and
customer debit atomically. Duplicate receipts cannot charge twice. Human logout
does not erase incurred charges. Ambiguous creation, missing receipts and
unexpected provider usage retain holds for reconciliation. Release needs durable
no-dispatch evidence or a definite 400/401/403/404/422/429 provider rejection.
An admin-domain SUPERUSER publishes tariffs in Billing → Nessie → Cloud browsers.
Customer charges use started minutes, minimum one minute, at the provider hourly
rate divided by 60 plus 10%. Nessie absorbs the fixed monthly provider fee.
Sandbox balances cannot fund real browsers. Expired tariffs prevent new sessions.
The public protocol package documents all bodies in BROWSER-BILLING.md and
schema/billing-browser-v1.json. Never send page contents, cookies or provider
credentials in financial evidence.
`;
