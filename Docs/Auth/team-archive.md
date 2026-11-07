# Shared team archive

`POST /org/organisations/:orgId/teams/:teamId/archive` archives the shared UOA
team across connected products. It does not execute the platform erasure flow.
The default and last team can be archived without cascading to an organisation
or deleting a person. Membership, product data references and financial history
remain. `Team.lifecycleStatus=ARCHIVED` denies authentication and scoped
credential issuance and removes the team from active directories and choosers.

The caller supplies `{request_id: UUID, deletion_held: true}`. The normal domain
credential, signed config and exact-team human assertion are required. The
service checks the current credential epoch, live organisation `teams.manage`
capability and active team membership under the enterprise outbox and exclusive
product policy fences. An organisation owner and administrator have the same
authority. Backend-only and team-only administrators cannot initiate this global
commercial operation.

The transaction writes one immutable `TeamArchiveOperation`, transitions the
team, revokes its refresh families, authorization codes and assurances across
every observed consumer domain, and emits the existing cross-product revocation
events. It disables exact-team automatic reload and closes team seat evidence.
Disabling reload advances the consent generation and clears current card and
consent pointers; immutable consent revisions and monetary balances remain.
It does not revoke the person's other teams or global identity. Products must
continue their existing live admission and revocation-consumer contracts; an
offline JWT alone cannot provide immediate revocation.

Billing reconciliation runs at startup and every 30 seconds, independently of
the new-collection enable flag. Each persisted customer's captured Stripe
account and livemode select its verified credential, preferring a matching
named binding over legacy credentials. It does not use the team's current mode
or the global legacy client. It processes both captured tuples when present,
and only UOA-owned TEAM customers matching the exact organisation and team.
Subscriptions cancel immediately with `invoice_now=false, prorate=false`; open
checkout sessions expire, draft/open invoices stop automatic advancement, and
unsettled payment intents are cancelled or re-read to confirm a terminal state.
Shared organisation customers, subscriptions and credits remain independent.
Historical accepted payments, liabilities and legal evidence are not refunded
or erased. A provider create holds the shared policy fence through its request,
so the archive drains admitted creates before its provider scan. Existing
persisted provider leases receive a settlement window before certification.
Cancellation starts immediately; certification waits for those leases and a
90-second provider settlement window, measured with the database clock.
Cancellation-recovery jobs cannot create or resume archived-team collection.
An ordinary disabled team can still settle its earned liabilities.
Usage export keeps that same distinction: archived teams cannot reserve or
dispatch meter events, while disabled teams remain eligible for earned usage.
Provider dispatch holds the archive fence through the meter request.

The initiating product reads the no-store receipt through
`GET /domain/team-archives/:id?domain=...` using its registered domain bearer
after the human session is revoked. This route cannot mutate the team or return
its content. An authorized receipt read also advances due reconciliation for
that exact operation, including on a request-driven host. `STOPPING_BILLING` is
not a success notice. `ARCHIVED` means that
reconciliation confirmed future team billing stopped. Provider failures and
processing payments leave the original operation pending, with expiring leases
and automatic retries; a lost cancellation response is recovered by inspecting
provider state. Browser retries must reuse the request UUID.

Permanent deletion is held by database constraints and triggers. The operation
cannot be deleted or rebound, the team cannot be reactivated or removed, and
platform organisation/team erasure previews include a hold blocker. No erasure
job or timer is created. Releasing the hold needs a separately designed and
authorized change; this API has no release action.

Focused checks: API typecheck; `team-archive` PostgreSQL integration suite;
`entity-lifecycle` regression suite; `team-archive-billing` provider tests; and
the checkout, recurring add-on, reload setup, usage export and scheduler unit
suites. PostgreSQL financial suites also cover consent disable, correction
collection fencing and organisation responsibility; set
`BILLING_FUNDING_DATABASE_TESTS=true` with `DATABASE_URL`. Use an isolated local
database and run browser journeys in the calling
product. Never archive a real team as a test.
