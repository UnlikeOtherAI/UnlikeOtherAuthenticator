export const llmSmsOperatorsMarkdown = `## SMS policy operators
Current platform SUPERUSER operators open Admin Billing > SMS policies.
GET /internal/admin/billing/sms-policies returns bounded private acceptance history.
POST /internal/admin/billing/sms-policies/fx/preview with {} fetches the fixed ECB
daily XML; {xml} imports that source document. Review its date, digest, exact
USD-per-EUR decimal and seven-day source-date expiry. POST /fx/accept under that
base with {preview_token,policy_understood:true,acceptance_reason} explicitly
adopts the informational reference rate as commercial policy.
POST /routes/preview under the same base imports exact account_sid, country,
direction, currency, additional_per_segment, additional_per_message, source,
evidence and expires_at. Review the server-computed complete-import digest;
/routes/accept also requires complete_segment_bound:true and
complete_message_bound:true. Zero bounds need documented support: missing
Pricing API fee evidence never means zero. Preserve original source documents
in the operator archive. Signed reviews last five minutes and bind operator and
credential epoch. Acceptance rechecks live ACTIVE platform authority under locks,
records subject/time/reason immutably and refuses stale evidence. Responses are
private/no-store. These controls neither enable billing nor provision resources.
Selected product > App keys > SMS runtime issues purpose sms_runtime independently
of customer lifecycle, entitlement and Ledger keys, with no redirect origins.
Transfer one-time plaintext only through approved deployment secrets.
The same SMS policies page exposes Number payment recovery. GET /recovery under
the policy base pages ending/recovery_required/refund_required resources; exact
/recovery/:resourceId shows the frozen final customer quote and original Stripe
account/mode/subscription/initial-invoice references. It cannot issue or verify a
refund. Existing manual contract-invoice adjustments do not settle SMS add-ons.
Use the authorized Stripe operator workflow and retain the unresolved resource
until verified refund reconciliation completes; no automatic zero-charge,
replacement resource or claimed refund completion follows from this read.
POST /recovery/:resourceId/verify-refund with exact subscription_id, distinct
existing refund_ids, reason and verify_existing_refunds:true reads the configured
Stripe account and mode, proves canceled original subscription, original paid
initial invoice and actual cash payments, full succeeded refunds and source-bound
balance movements. After locked operator/resource/binding rechecks it records an
immutable digest/time, audits the decision and changes refund_required to ended.
It never creates refunds or changes Stripe subscriptions. Incomplete, pending,
foreign or conflicting evidence remains unresolved; exact retry is idempotent.
GET /liabilities?kind=inbound|outbound pages original allocation/team/account/
message/dispatch bindings and final customer held/consumed/uncollected credits.
Unknown amounts remain null. This review makes no financial write and grants no
resend/release authority; recover original receipts through the product runtime.
`;
