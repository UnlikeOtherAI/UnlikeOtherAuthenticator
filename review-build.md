VERDICT: ship with changes

Review limitation: the single permitted `cat` was truncated by the environment,
so §3.3–§5 and §8–§9 (auth boundary, endpoint schemas, lane details) were read
only through their cross-references from the surviving sections. Findings below
are solid where cited; anything touching §4–§5/§8–§9 internals is provisional
and should be re-checked against the full text.

BLOCKING

1. §7.5 + §10 Phase 1 — the shared `packages/uoa-ui` extraction is loaded into
   the thinnest phase. Phase 1's stated value is "a real person signs in and
   sees their workspaces." That does not require a cross-app refactor: git-mv
   out of the Auth window, Tailwind content-glob surgery in two apps, workspace
   wiring, Dockerfile changes, and a byte-identical Auth guarantee enforced by
   screenshots. It directly violates the repo's "no premature abstraction" and
   "build exactly what is specified" rules — the design even admits the new
   Dialog/ConfirmDialog/Menu are only "candidates to move" when the Auth window
   needs them, which contradicts moving everything preemptively. Fix: Phase 1
   copies the ~10 listed files into `/Account` verbatim (imports rewritten);
   extraction becomes its own later phase triggered by an actual second-consumer
   need. This shrinks Phase 1 by roughly half and removes the only change that
   can break an unrelated production app.

2. §3.1 — the Home screen has no zero-state design, yet it is the first screen
   a brand-new user sees (and Q1 recommends allowing registration, meaning a
   person can land here with zero orgs, zero teams, zero invites). The §6 gate
   table references an "empty-state create form" that §3.1 never wires up. An
   implementer must invent the most important state of the most important
   screen. Fix: add the empty-state wireframe (what renders, what the create
   form posts to, what happens on success) before Phase 1 starts.

3. §3.1 — invite cards render "expires in 12 days," but nothing in the visible
   text pins invitation expiry into the `GET /account/me` (§9.1) schema. The
   design leans on `buildSidebarPendingInvites`, whose payload is not shown to
   include an expiry. This is exactly the "control depending on data no listed
   endpoint returns" failure mode. Fix: pin the invite object schema (at
   minimum: org/team identity, inviter email, expiresAt) in §9.1, or drop the
   expiry line from the card.

4. §3.2 — the People section shows "Load more," implying member-list
   pagination. The design asserts the `/org/*` contract is complete but never
   states whether `GET …/members` paginates or what the portal does when it
   does not. Fix: one line confirming the endpoint's pagination behaviour and
   the portal's fetch pattern, or remove the control.

NON-BLOCKING

- §10 Phase 4 item 3 — i18n (`language_config` beyond `en` via a "shared
  I18nProvider") is pure scope creep: not in §1 scope, no consumer demand
  stated, and the named I18nProvider does not appear in the §7.4 extraction
  table, so it is an unspecified dependency too. Cut it, or defer to the same
  future phase as the extraction where it would have a home.
- §10 Phase 4 item 1 — the `ClientDomainConfigSnapshot` table plus per-request
  substitution of a foreign domain's `org_features` into `request.config`
  inside the account arm of `requireOrgRole` is heavy, security-sensitive
  machinery (mutating request config from a persisted snapshot) for the
  cosmetic problem of exact role-label fidelity. The interim default vocabulary
  is acceptable; make this its own design rather than a phase task, and do not
  let "substitute into request.config" ship without a threat review.
- §9.1 `GET /account/me` partially re-invents the existing `GET /org/me` (orgs,
  teams, roles, invites). The aggregation is justified for Phase 1 (the lane
  arrives only in Phase 2) and the capability/policy additions are genuinely
  new, but the design should state explicitly why `/org/me` was not extended
  instead, so the next implementer does not maintain two directory endpoints
  by drift.
- §6 — org People "role select" gates on `org.isOwner` while the surrounding
  copy says "role select + ⋯ only with the matching capability." Pick one rule
  (owner-only, per the API) and make the table and §3.2 agree.
- §10 Phase 2 — lane + §9.7 endpoints + full org page + full team page + create
  org/team + self-join in one phase is the largest phase by an order of
  magnitude. Shippable, but if anything slips it all slips; splitting
  invitation accept/decline (which unblocks the already-rendered Phase 1
  invite cards) into its own thin phase would de-risk.
- §3 heading "Information architecture" appears twice in the rendered output —
  check the file for a duplicated section (possibly a truncation artifact, but
  verify).
- Repo rule "no file over 500 lines": §3.2/§3.3 as specced (header card, three
  to five sections, approvals, danger zone, all dialogs) are file-size risks.
  State the decomposition expectation (section components, dialogs colocated)
  in §12's architecture doc so the implementer does not land one 900-line page.

WHAT TO KEEP

- §6 capability-driven gate table with the three implementer rules — hiding as
  courtesy, server refuses independently, role label never interpreted. This
  is the strongest part of the document; it converts an ACL into buildable UI
  logic.
- §5's error-state table branching on HTTP status + what `/account/me` already
  said, never on production-squashed codes — correct constraint discipline.
- §1's not-scope table, especially billing, email change, and "no add-member-
  by-id" — each has a real architectural reason, not just preference.
- Reusing the parameterised `static-spa.service.ts` and the admin OAuth shape
  rather than inventing a third serving/auth pattern (§2 facts 1–3 show the
  domain constraint was actually understood).
- Separating the portal from `/admin` by config identity rather than domain —
  the one deliberate departure from "copy the admin," and the right call.
- Phase 5 correctly gated on Q9 instead of being built speculatively.
