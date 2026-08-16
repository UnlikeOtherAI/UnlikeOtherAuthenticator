# Org billing override — one bill for the whole organisation, across all products

> **Status:** UOA side implemented, 2026-08-16 (`task/org-billing`). §1–§6 are
> in `API/` and protocol **1.3.0** is published; product rollout (the table at
> the end) has not started. Authority-side capability: this is a UOA feature.
> Products render it and implement none of it.
>
> **Three decisions taken during implementation, deliberately different from
> the sketch above — see "Implementation notes" at the end.** The wire field is
> `controlled_by` in snake_case, the organisation view is additive rather than a
> replacement, and the actor-assertion audience contract is now stated rather
> than changed.
> **Companion:** the per-product billing-consistency audits landing today as
> `docs/plans/2026-08-15-billing-sso-audit.md` in nessie, water,
> deepsignal.live, DeepTest, AdGoes.live and docgen. Constraints they surface
> are folded in below under "Audit constraints".

## The ask

An organisation should be able to take over billing for **all of its teams
across all products**: one place to see and manage spend, credits, payment
method and invoices for the whole org. While that override is on, each team's
own billing surface stops offering controls and simply states that billing is
managed organisation-wide.

## Where this lives, and why

UOA is the sole commercial authority: tariffs, statements, credits, top-ups,
subscriptions, adjustments and the Stripe lifecycle are UOA's, and products
render UOA's display-ready models without doing tariff math or holding
commercial state. An "org override" is therefore **not** six product features;
it is one UOA capability plus a protocol field that products already know how
to render. Any product-side branch that computes who pays would be the same
class of violation as a local user table.

## What already exists (verified in source, 2026-08-15)

| Concern | Today | Org-ready? |
|---|---|---|
| Tariff assignment | `BillingTariffAssignment.scope: ORGANISATION\|TEAM` + `scopeKey`, unique per `(serviceId, scope, scopeKey)` (`API/prisma/schema.prisma:1562-1586`) | **Yes** |
| Commercial adjustments | Same scope pair; resolution reads **both** scopes and unions them (`billing-commercial-adjustment.service.ts:104,162-163`) | **Yes** |
| Stripe subscription | Route already accepts `scope: organisation\|team` + `scope_key` (`routes/billing/stripe-subscription.ts:37-51`) | **Yes** |
| Credit account | `BillingCreditAccount.teamId String` — **NOT NULL**; resolution hard-codes `BillingAssignmentScope.TEAM` with `scopeKey = "${orgId}:${teamId}"` (`billing-credit-account.service.ts:87,99-108`) | **No — the gap** |
| Customer statement | Bound to `organisation_id` + `team_id` per request (`routes/billing/customer-statement.ts:109-110,138-139`) | Partly — takes both, but answers per-team |

So the estate is already half-built for this: **scope is a first-class idea
everywhere except the money itself.** Credits, funding and the statement are
strictly per-team, and that is exactly what the override has to move.

## Design

### 1. One new authority record

```
model BillingOrgResponsibility {
  id             String    @id @default(cuid())
  orgId          String    @unique @map("org_id")     // one per organisation
  active         Boolean   @default(true)
  assumedAt      DateTime  @map("assumed_at")
  assumedByUserId String   @map("assumed_by_user_id")
  releasedAt     DateTime? @map("released_at")
  ...
}
```

Deliberately **org-wide across every service**, not per-product: the ask is one
bill for the whole organisation, and a per-service dimension would multiply the
state machine below by the number of products for a case nobody has asked for.
The existing `(scope, scopeKey)` convention leaves room to add it later without
a breaking change.

### 2. Credit accounts gain the scope every neighbour already has

`BillingCreditAccount.teamId` becomes nullable, joined by the same
`scope`/`scopeKey` pair its neighbours use (`scopeKey = orgId` for
`ORGANISATION`, `"${orgId}:${teamId}"` for `TEAM` — unchanged for existing
rows). `resolveCreditAccount` becomes:

1. Org responsibility active → resolve-or-create the **ORGANISATION** account.
2. Otherwise → today's TEAM account, byte-identical.

Every debit already flows through this one resolver, so metered spend from any
team lands on the org account the moment the override is on, with no per-call
change anywhere in Ledger or the products.

### 3. The statement answers at the scope that is paying

`POST /billing/v2/customer-statement` keeps taking `organisation_id` +
`team_id` (products cannot know the answer, and must not have to). UOA decides:

- **Override off** — today's per-team statement, unchanged.
- **Override on, caller is an org billing manager** — the org statement:
  portfolio grouped **by team, then by user**, one credit balance, one payment
  method, one set of funding actions. This reuses the existing
  `metering-portfolio-v1 group_by=user` snapshot with a team grouping above it;
  no new rating, no new maths.
- **Override on, caller is an ordinary member** — the privacy-safe projection
  they get today, plus the controlled-by block below; their own usage stays
  visible, other members stay anonymous.

### 4. What a team surface renders — UOA's words, not the product's

The protocol gains one optional block on both the statement and the credits
view model (additive, `@unlikeotherai/billing-statement-protocol` **1.3.0**):

```jsonc
"controlledBy": {
  "scope": "organisation",
  "organisationId": "org_…",
  "organisationName": "Acme",     // display-ready
  "message": "Billing for this workspace is managed for the whole organisation.",
  "canManage": true,               // caller is an org billing manager
  "manageActionId": "org-billing-open"   // present only when canManage
}
```

Products render `message` verbatim and, when `canManage`, offer the one action
UOA names — exactly the "action labels and disabled reasons come from UOA" rule
that already governs every other control. **No product composes that sentence.**

**Old-client safety is part of the contract, not an afterthought.** A 1.2.0
client does not know `controlledBy`, so with the override on UOA must also
return the team view with an **empty actions list and no funding controls** —
an un-upgraded product then shows a read-only statement rather than buttons
that would 403. Degrade honestly; never rely on the client having upgraded.

### 5. Turning it on and off is a stated migration, not a silent switch

This is the part that will bite if it is hand-waved. At the moment of enabling,
teams may hold live Stripe subscriptions, auto-top-up consents, positive credit
balances and in-flight cancellation intents.

- **Enabling** is refused while any team in the org has an in-flight funding
  action (checkout, top-up attempt, cancellation intent) — same 409-with-a-reason
  discipline as the DeepWater active-runs guard. Cleanly: cancel or let it settle.
- **Team credit balances are not swept.** They remain the team's, are spent
  down first for that team's usage, and are shown on the org statement as
  per-team residual balances. Moving money between accounts on a toggle is a
  transfer nobody consented to.
- **Team auto-top-up consents are deactivated** (not deleted) with an audit
  row; the org account's own consent takes over. Releasing the override
  re-exposes them as inactive for explicit re-consent — a stored payment
  consent must never silently resume.
- **Live team subscriptions** are the one case with no safe automatic answer:
  enabling is refused with `TEAM_SUBSCRIPTIONS_ACTIVE` listing them, and an
  operator moves or ends them first. (Alternative — auto-migrate to the org
  scope — was rejected: it re-bills a customer without a decision.)
- **Releasing** the override reverses the resolver only; historical org-scoped
  ledger rows, invoices and statements stay on the org account where they were
  actually incurred. History is never re-scoped.

### 6. Who may do it

Enabling, releasing and managing org billing require an **org-level billing
manager**, checked by UOA on every call (never trusted from the product), with
the same fresh 45-second actor assertion and `tv` epoch the existing billing
actions use. Team billing managers keep their role; while the override is on it
simply resolves nothing to manage, which is what `canManage: false` +
`message` says on their surface.

## What each product does

Nothing but re-vendor the protocol and render two things: the `controlledBy`
block where a statement or credits view carries one, and the single org action
when `canManage` is true. That is the whole product-side change, in all six.
The SHA-256 manifest gate each repo runs over the vendored package is what
proves they are on the same contract.

## Rollout order

1. UOA: schema + resolver + statement scoping + guards + admin surface, behind
   the responsibility record (absent = today's behaviour, so shipping is inert).
2. Protocol 1.3.0 published; UOA emits `controlledBy` and the safe empty-action
   team view.
3. Products re-vendor at their own pace — each one's SHA gate proves it, and
   the old-client rule means an un-upgraded product is never wrong, only plain.
4. Enable for a pilot organisation; verify the per-team surfaces say the right
   thing in every product before general availability.

## Verification this design owes

- A team's metered spend lands on the org credit account with the override on,
  and on its own account with it off — asserted at the resolver, which is the
  single chokepoint every debit crosses.
- Enabling is refused (not partially applied) while any funding action is in
  flight; releasing restores team resolution with no ledger rewriting.
- An ordinary member's team view under the override exposes no funding action
  and no other member's name.
- A 1.2.0-vendored product renders the override state without offering a
  control that would 403.
- The org statement's totals equal the sum of its teams' metered usage for the
  period — proved against one pinned Ledger portfolio snapshot, with no
  product-side arithmetic anywhere in the path.

## Audit constraints (six product audits, 2026-08-15)

Per-product billing audits landed today
(`docs/plans/2026-08-15-billing-sso-audit.md` in each repo). Readiness to
render an org override, worst first:

| Product | Billing today | Blocks org override? |
|---|---|---|
| **DeepTest** | Conformant "in every material respect audited" | No |
| **DeepSignal** | Conformant; SHA gate not run in the deploy pipeline; action set hardcoded | No — fix the deploy gate |
| **water** | Substantially conformant; **G1**: the statement is manager-gated *locally* from the session role claim | No, but G1 must go — see below |
| **Nessie** | Conformant reads/actions; **P1** assertion audience wrong; **P2** hand-written checkout/portal schemas; owner-only local cost estimates | No, with P1 fixed |
| **docgen** | **G1** no protocol package at all (hand-rolled validators); **G2** browser supplies the cancellation-confirm body; **G3** billing tracks the last-login team, no switcher | **Yes** |
| **AdGoes.live** | None — "trivially compliant by absence"; a permanently disabled Billing menu entry | No, but org billing would be its first billing surface |

Four findings change this design rather than merely sitting beside it:

1. **The actor-assertion audience is wrong estate-wide, and this design
   multiplies it.** Nessie pins `aud` to `…/billing/v1/effective-tariff` on
   every billing call including statement, credits, Stripe and cancellation
   (`api/src/services/uoa-billing-client.ts:199,224`); DeepSignal reports the
   same shape. Either UOA does not verify `aud` per endpoint — in which case
   the assertion is unscoped and replayable across the whole billing API for
   its TTL — or it does, and these calls only work by accident. **UOA must
   decide and state the audience contract before org-scope endpoints are
   added**, because the override introduces a new, higher-privilege action
   surface (org funding for every team) that must not inherit an
   audience nobody is checking. Treat as P1, ahead of this feature.
2. **The protocol package does not cover the actions this design adds.**
   Checkout-session and portal-session envelopes are absent from
   `@unlikeotherai/billing-statement-protocol`, so Nessie hand-writes them
   (`packages/schemas/src/uoa-billing-actions.ts:6-41`) and docgen hand-rolls
   everything. Publishing `controlledBy` alone is not enough: **1.3.0 must
   also publish the checkout/portal envelopes**, or each product will
   hand-roll the org variants too and the parallel-contract problem doubles.
3. **"Controlled org-wide" must be a server verdict, not a client role
   check.** water currently decides manager-vs-member in the browser from the
   session role claim (`Billing.tsx:13-14`). Under an org override the
   question changes from "is this person a team billing manager" to "is this
   person an *org* billing manager" — a claim the session does not carry.
   `controlledBy.canManage` being UOA-computed is therefore load-bearing, and
   water's local gate must be replaced by it rather than extended.
4. **A product that cannot name its active team cannot render this.**
   docgen's billing follows the last-login team with no switcher (G3), so
   "billing for this workspace" has no reliable referent there. Its identity
   work package (WP-3 switcher) is a hard prerequisite; likewise its G1/G2 —
   a product whose browser supplies the cancellation-confirm body must not be
   handed org-wide funding actions.

Sequencing consequence: **UOA-side work (§1–§3, §5, §6) can start now.**
Product rollout order becomes DeepTest and DeepSignal first (already
conformant), then water and Nessie once G1/P1 land, then docgen after its
identity and protocol work, with AdGoes.live building its first billing
surface directly against 1.3.0 — the one product that gets to skip the
migration entirely.

One open question for UOA, surfaced by Nessie's audit and worth answering in
writing while this is designed: Nessie persists per-million pricing rates and
computes owner-only *operational* cost estimates (`ModelPricingProfile`,
`estimatedCostAmount`), held strictly apart from customer billing and never
shown to members. Is that "an estimate of provider cost for ops" (allowed) or
"computing a tariff" (barred)? The org override makes the answer more
pressing, because an org-wide view is exactly where an operational estimate
and a customer statement would be tempting to render side by side — and the
`/tokens` vs `/ops/usage` split exists precisely to stop that.

## Implementation notes (2026-08-16)

Three places where the built thing differs from the sketch above, and why.

1. **`controlled_by`, not `controlledBy`.** The JSON snippet in §4 is
   camelCase; every other key in both the statement and the credits contracts
   is snake_case (`credit_account_id`, `disabled_reason`,
   `connected_service_usage`). The contract's internal consistency wins, so the
   wire field is `controlled_by` with `organisation_id`, `can_manage` and
   `manage_action_id`. The TypeScript type is `BillingControlledByV1`.
   `manage_action_id` is present-and-null rather than absent when
   `can_manage` is false, matching the package's existing
   `disabled_reason: string | null` style.

2. **The organisation view is additive, not a replacement.** §3 reads as though
   an organisation billing manager's request returns *the organisation
   statement* in place of the team's. It does not: the requested team's own
   fields stay exactly what they are, and the roll-up arrives as
   `organisation_scope` on v2. This follows from §4's own rule. A product still
   vendoring 1.2.0 does not know `organisation_scope`, but it does know
   `totals` — if those silently became organisation-wide, an un-upgraded
   product would confidently display the wrong number for the team, which is
   exactly the failure §4 exists to prevent. Additive is the only shape that
   degrades honestly. `organisation_scope.totals` is the sum of its teams'
   totals, computed by the same `billingCommercialTotals` summation UOA already
   applies to one team's lines.

3. **The actor-assertion audience contract is stated, not changed.** The audit
   finding (§"Audit constraints" 1) asked UOA to decide before org-scope
   endpoints were added. It is decided, and it was already the second of the
   two possibilities: `verifyBillingActor` verifies `aud` against
   **`BillingAppKey.actorAudience`** — the audience registered for that
   product's app key — not against the endpoint being called. So an assertion
   is scoped to *a product's billing surface*, and Nessie pinning
   `…/billing/v1/effective-tariff` works because that is its registered
   audience, not by accident. Per-endpoint scoping is provided by a different
   mechanism: every mutating action goes through
   `authorizeBillingCustomerAction`, which consumes the actor's `jti` exactly
   once *per operation* and binds it to a digest of the request body. The two
   new operations (`org_billing_assume`, `org_billing_release`) use it, so an
   assertion spent taking billing over cannot be replayed to release it, or to
   open a checkout. No estate-wide `aud` change was needed, and none was made:
   changing it would break every product at once for no gain in scoping.

Also worth recording, because it is a constraint the next person will hit:
`billing_credit_auto_top_up_disable_events` is unique on
`(app_key_id, actor_jti)`, which is right for a customer switching one team's
automatic top-up off and wrong for one assumption that has to switch several
teams off at once. The evidence rows written by an assumption therefore carry a
namespaced, deterministic
`org-billing-assume:<responsibilityId>:<creditAccountId>` in `actor_jti` — it
cannot collide with a real token id, it makes a retried assumption idempotent,
and the real requesting user and app key are still recorded on the row.

### Not built here

- **No admin surface.** §"Rollout order" step 1 lists one; the API is reachable
  by the products' own billing backends, and no `/Admin` screen was added. That
  is a deliberate gap, not an oversight — name it before general availability.
- **The pilot enablement (step 4) has not happened**, and no product has
  re-vendored 1.3.0.
