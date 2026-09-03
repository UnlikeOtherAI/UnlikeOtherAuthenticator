VERDICT: ship with changes

Hostile review of Docs/plans/2026-09-03-account-portal.md. Checked against
API/src/routes/org/me.ts and API/src/middleware/org-role-guard.ts only, per
budget. One contradiction must be fixed in the document before Phase 2 starts;
everything else is tuning.

BLOCKING

1. §1 directly contradicts §4.5 on org-level "add member by user_id", and §4.5
   silently widens a boundary the design itself closed. §1 (Not in scope):
   "POST /org/organisations/:orgId/members takes a user_id, which a person
   cannot know; it stays a backend affordance." §4.5 then puts the *entire*
   `organisation-members.ts` file on the lane — its own table lists "list,
   add, role, remove, deactivate, reactivate" — and §9.10 repeats "no add org
   member by id surface" while §4.5 hands the account session the route that
   does exactly that. The net effect: any org owner with an account token can
   bind an arbitrary `user_id` into their org without an invitation, which is
   precisely the affordance §1 says does not exist for people. (§3.3's "Add
   from organisation" is fine — that is the *team* members route fed from the
   org members list the person is already allowed to read.) Fix: either remove
   `POST .../members` from the §4.5 lane table and add a per-route exception,
   or amend §1 with an explicit justification for widening it. The doc cannot
   ship asserting both.

2. §9.7's load-bearing assumption is unverified and the doc does not mark it as
   such. The account accept arm calls `acceptTeamInviteWithinTransaction({
   config: accountConfig })` where `accountConfig.domain` is the auth host
   while the invite's team/org may live on `app.nessie.works`. The design
   claims parity with the backend-mode accept, but that route runs under the
   *source product's* config and the `/auth/select-team` bridge runs under the
   *signing-in domain's* config — neither proves the service function tolerates
   a config whose `domain` differs from the invite's origin domain. If it (or
   `declineTeamInviteForUser`) asserts domain equality anywhere, Phase 2's
   headline feature fails at integration time. Add an explicit implementation
   step in Phase 2: read `team-invite.service.acceptance.ts`, confirm no
   config-domain === org-domain assertion, and if one exists specify the
   minimal refactor. Do not leave this to "verified 2026-09-03" — the one file
   that matters was not checked.

NON-BLOCKING

Security

3. §4.4 changes `resolveAccessTokenContext` from a domain-keyed branch to a
   config-URL-keyed branch with `500 FIRST_PARTY_CONFIG_UNKNOWN` for any other
   first-party URL on the admin domain. Fail-closed is the right default, but
   the plan does not ask whether any such config exists today (dev/staging
   configs, hand-rolled local setups) or what breaks when it starts answering
   500. Add a migration note: enumerate existing configs on `ADMIN_AUTH_DOMAIN`
   before deploy. Separately: every other verifier of admin-domain access
   tokens will simply fail to verify account tokens (different HMAC secret) —
   correct, but the doc should state that this is the *mechanism* that keeps
   account tokens out of product paths, not just the two named guards.
4. §8.2's stolen-token analysis omits one axis: the lane makes
   `GET /org/organisations/:orgId` and the members list readable cross-domain
   by a bearer that a *product* session token could never be. That is a mild
   PII widening (member emails/names readable with a 60-minute token against
   any org you're a member of, from any origin). It mirrors what
   `all_active_memberships` already permits server-to-server, but the doc
   should say so explicitly rather than claiming "nothing more than the
   person's own actions in the portal" is reachable.
5. §8.5 rate-limits `/account/password` at 5/15 min per user id. A legitimate
   user who fumbles their current password twice in a row is one lockout away
   from a support ticket, and the per-user bucket is also the attacker bucket.
   Suggest 10/15 min per user plus a stricter per-IP bucket, or a step-up
   cooldown after the third failure.
6. Phase 5 (if Q9 ever activates it) reintroduces a credential in a cookie.
   SameSite=Strict + scoped Path is decent but the plan should commit up front
   to a custom-header/CSRF-token check on the refresh grant and a stated
   rotation-under-tokenVersion-bump test, or drop the phase. A refresh cookie
   that survives "sign out everywhere" would be a real regression; the design
   doesn't say whether revoke-all also burns the portal family (it must).

Reuse / capability model

7. §9.1's `policy.twoFa` is specified as the all-organisations mode of
   `resolveTwoFaPolicy`, but that change is Phase 3 (§9.6) while `/account/me`
   ships in Phase 1. State the interim resolution (domain policy only) so the
   Phase 1 contract is not silently half-specified.
8. Phase 4 item 1 (`ClientDomainConfigSnapshot` — a new table, a write path in
   config verification, and substitution into `request.config`) is the largest
   single piece of machinery in the document, built for a case (a product
   domain with custom `role_grants`) that per §1 may not exist anywhere in the
   estate. Recommend gating it explicitly on Q4 naming a real domain with
   custom grants, and shipping the interim rule as permanent until then. This
   is the main over-engineering risk against the repo's "build exactly what is
   specified" rule.
9. §6's gate table says the People role select shows when `org.isOwner`, and
   §9.10's owner-removal note exists, but neither states the corollary the
   implementer will hit: the API also refuses changing the *owner's own* role
   (ownership moves via transfer only). One line in §6 prevents a false bug
   report in Phase 2 verification.

Buildability / process

10. Q3 (auth-host `ClientDomain` allowlist must be empty, and `twoFaPolicy` is
    now shared with the admin sign-in) is a go-live gate, not an open question.
    §8.3.3 buries it. Move it into the Phase 1 verification list as a checked
    pre-flight, or the first deployment can silently lock the portal (or the
    admin panel) to an allowlist someone set two years ago.
11. Phase 1's byte-identical-Auth guarantee rests on the Vitest suite plus one
    Playwright screenshot. The extraction moves theme *and* `WorkspaceList`/
    `WorkspaceCard`/`InviteCard` renderers that the chooser depends on. Add
    one chooser-flow screenshot (post-login workspace selection) to the Phase 1
    verify list; the home page screenshot does not cover the moved components'
    heaviest consumer.
12. §4.6's claim that static routes win over the SPA wildcard "by Fastify's
    radix routing" is correct (find-my-way: static > parametric > wildcard)
    but worth a route-registration-order note — `registerSpaRoutes` must run
    after `routes/account/*` or the 404 fallback for unknown `/account/*` API
    paths will return `index.html` with 200.

What the design got right — do not undo

- §8.1's rejection of a BFF is the correct call and the stated reason is the
  right one: a server-side holder of the domain hash turns every portal call
  into backend mode with a spoofable on-behalf-of, the exact promotion
  `resolveOrgAccessTokenHeader`'s comment exists to prevent.
- The lane resolves org context live per request via `getActiveClientOrgContext`
  (§4.5) instead of relying on the token's single `org` claim — this is the
  only shape consistent with `assertRequiredOrgRole`'s `claims.org.org_id ===
  :orgId` check (verified in org-role-guard.ts) and with a browser that holds
  no refresh token for the workspace-switch grant.
- Leaving `domainAuthClientDomainId` unset on the account path so
  `acceptDomainBackendCaller` check (1) can never pass is a structurally sound
  way to make backend mode unreachable — it reuses the existing guard rather
  than adding a parallel one.
- The bearer discriminator (64-hex hash vs JWT-with-dots, §4.5 step 1) is
  unambiguous and fail-closed; a malformed token is never retried as a hash.
- Two HMAC secrets plus the `client_id` check on both guards (§4.4) means a
  SUPERUSER's account token is not an admin token even though both configs
  share `domain`; and the §8.3.1 bootstrap `503` structurally closes the
  "first visitor to `/account` becomes platform superuser" hole that sharing
  `ADMIN_AUTH_DOMAIN` would otherwise create. Both are easy to get wrong and
  are not.
- §9.4's password change is correct on every axis that matters: current
  password required (so a stolen session alone cannot rotate the credential),
  TOTP required when enrolled, argon2 dummy-hash timing flatness preserved,
  generic `400`, and full revocation — every refresh family plus `tokenVersion`
  including the caller's own token — matching `resetPasswordWithToken`'s
  established consequence rather than inventing a softer one.
- "Set a password" reusing the existing reset-email flow (§9.4) instead of
  minting a new endpoint is exactly the right reuse; so is §9.5's justification
  (browser holds no refresh token, so `/auth/revoke` is unusable).
- The account config deliberately diverging from the admin policy
  (`assertAccountConfigPolicy` not requiring Google-only / registration-off,
  §4.2) — the difference *is* the product; copying the admin policy table
  wholesale would have been the lazy failure.
- §9.6 is small, justified, and correctly scoped (portal arms only, product
  calls unchanged). Without it the portal would display a 2FA state the next
  product login contradicts.
- Serving: generalising `admin-ui.service.ts` into `static-spa.service.ts`
  with a two-line admin re-export (§4.6) and `packages/uoa-ui` as `git mv`
  extraction (§7.5) avoid the two most likely copies (a second SPA-serving
  stack, a second design system).
- Exclusion list (§4.5 "Not on the lane") is right: `GET /org/organisations`
  is `requireOrgBackendOnly` and must stay that way; `/org/me` is replaced by
  `/account/me`; `/auth/token` untouched. Keeping `/2fa/*`'s existing
  `X-UOA-Access-Token` path untouched while adding the account arm limits
  regression surface.
- No new public error codes, UI branching on HTTP status plus what
  `/account/me` already reported (§5), and the `schema.account.ts` +
  `llm-account.ts` sync plan honour the repo's machine-readable-contract rule.
- §3.3's handling of the `invited: []` (never 403) behavior and §6's rule that
  the role label is display-only (`capabilities` + `isOwner` are the only
  booleans) match how `role-grants.ts` / the capability plan actually behave.
