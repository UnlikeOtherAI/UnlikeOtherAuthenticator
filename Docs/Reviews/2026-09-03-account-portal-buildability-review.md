VERDICT: ship with changes

# Hostile buildability review — slice-build-core.md

## BLOCKING

1. §3.5 / §6 — "Signs in with: Email, Google" and the social-only branch of the
   Security page need a list of linked identity providers per user, but no
   endpoint in the phase plan returns it. §6 gates **Change password** on
   `user.hasPassword` (so `/account/me` must carry that flag), yet the Profile
   screen renders a provider list and §3.5 renders a "Set a password" button
   "if social-only" — none of Phases 1–3 adds a `GET /account/identities` (or
   equivalent) endpoint, and the assumed-complete `/org/*` surface is org/team
   scoped, not user-identity scoped. A competent implementer hits this the
   moment they build the Phase 1 "Profile read-only" screen. Either specify the
   endpoint and its phase, or cut the provider list from the mock.

2. §6 (gate table) contradicts §6 (intro paragraph). The intro says
   `PUT …/members/:userId` is one of "the three structural owner-only powers"
   requiring `Organisation.ownerId === actor`, and claims capabilities are
   "computed server-side with the very functions the write routes use". But the
   table gates Org → People role selects and ⋯ Remove/Deactivate/Reactivate on
   `org.capabilities['members.manage']`. If role change and deactivate really
   route through `PUT …/members/:userId`, every non-owner admin sees controls
   that always 403, and the doc's own §5 "403 on a write" state becomes the
   designed behaviour for a whole control class — which the table's "Shown to a
   person who lacks it: No ⋯" column explicitly forbids. If instead deactivate
   is a different route gated on `members.manage`, the intro is wrong. Pick one;
   an implementer cannot resolve this from the document and must not guess.

3. §3.1 — the Home screen's data contract for teams the person is not a member
   of is unspecified. §5 says `/account/me` lists only ACTIVE membership rows,
   and §3.1 mocks a `+ Join "Design"` row for OPEN_TO_ORG teams and a
   `not a member` row on the *org* page (§3.2, where "org member sees all
   teams"). It never says whether Home renders INVITE_ONLY or HIDDEN teams the
   person isn't in, and whether `/account/me` embeds non-member teams at all.
   "Data: GET /account/me once" is asserted, not specced. Define the response
   shape for org cards (teams array scope, role strings, `memberInvites`,
   `capabilities`, `isOwner`, `isDefault`, `joinPolicy` per team) or the Home
   mock is unbuildable against the pinned contract.

4. §3.2 / §3.3 vs repo rule (no file over 500 lines). Both screens are specced
   as single scrolling pages carrying 5–6 sections plus 4–5 dialogs each
   (§3.2: rename, icon, invite-policy, transfer, delete; §3.3: invite-by-email,
   add-from-org, new-link, plus header ⋯ items). Built naively as one page
   component per mock, either file blows the 500-line cap. The slice names the
   shared primitives (§7.4 Dialog, QueryState) but never allocates the section
   and dialog decomposition. This is cheap to fix now and expensive after an
   implementer has to re-chop a 900-line OrgPage.

## NON-BLOCKING

- Phase 1 is not the thinnest sign-in-and-see-workstreams slice: it includes a
  read-only Profile page and `AvatarImage` (§10, item 3), both of which Phase 3
  immediately reopens for editing. Cut both from Phase 1; Phase 1 = shell,
  sign-in, callback, session, read-only Home. Profile arrives once, editable.
- Phase 4 item 3 (`language_config` beyond `en` via I18nProvider) is speculative
  scope: the slice itself says the account config's default vocabulary governs
  "until then" (§10, item 1 note) and never states a non-en language is
  configured. Defer until a deployment actually serves one.
- Phase 4 item 1 (`ClientDomainConfigSnapshot` and config substitution into
  `request.config`) is the largest and riskiest change in the whole slice — it
  mutates the confidential-exchange request path — and it is justified by an
  open question ("Q4") rather than a confirmed defect. Ship Phases 1–3 without
  it; gate it on evidence that a product-created org's grant table actually
  diverges in production.
- §3.5 "Sign out everywhere — signs you out of every product" has cross-product
  blast radius the portal owner may not intend to vouch for in v1. It is
  specced, so not creep, but the copy promises more than the portal controls;
  consider "every UOA session" or defer the claim.
- §3.2 Transfer dialog: "the outgoing owner becomes `admin` unless the
  vocabulary lacks it" is an unbranchable instruction — if the vocabulary can
  lack `admin`, the implementer needs the specified fallback (member? error?),
  not discretion.
- §5 "403 on a write → toast + refetch + controls disappear" fires a full
  `/account/me` refetch on every stale-capability 403; fine, but state that a
  single refetch is the design so nobody builds per-control polling.
- Duplication check owed: the operator admin panel already exists. Before Phase
  2 starts, confirm it does not already ship org/team/people/invitation
  management screens the portal would re-implement; if it does, either reuse or
  write down why the audience difference justifies the parallel UI. The auth
  popup's LoginPage auto-start pattern is correctly referenced rather than
  reinvented (§3).

## What to keep

- The IA table with per-screen "decision it serves", and the explicit
  exclusions (no `/account/teams`, no `/account/members`, no search) — this is
  exactly the discipline "build exactly what is specified" needs.
- The §5 states table: error-status-driven copy, no reliance on production-
  squashed error codes, "the client never guesses a reason the server
  withheld" — correct against the production squash and worth pinning as a
  rule.
- The §6 gate-table format itself (visible-when / shown-to-who-lacks-it),
  including "hiding is a courtesy, the server refuses too" — the right model
  for capability-driven UI; it just needs the blocking contradiction in
  finding 2 resolved.
- Phase 5 being explicitly conditional on Q9, with the refresh token still
  never visible to the browser — conditional scope done right.
- Phase 1's verification rigour (guard unit tests, capability pinning against
  `LEGACY_DEFAULT_ROLE_GRANTS`, screenshot-byte-identical auth window) —
  provided the extraction itself survives the duplication check above.
- `join_creator: true` on team creation with the fix commit cited (§3.4) — the
  kind of concrete, verifiable detail that keeps an implementer out of the
  "creator isn't a member" trap.
- One `QueryState` primitive owning all four render states on every screen.
