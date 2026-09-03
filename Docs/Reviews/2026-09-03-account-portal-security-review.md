VERDICT: ship with changes

Hostile review of account-slice-security.md (design only, no code). Read once in
full; §4.5's guard table and parts of §5–§8 were truncated mid-document, so
findings cite the sections as read. Facts about the existing system (HS256 user
tokens, single-org claim guard, config-domain rule, email-token-only reset)
taken as given.

## BLOCKING

1. **§4.5 / §9.8 — the account bearer is now a single credential that alone
   authorises every user-mode write across every org.** Today the `/org/*`
   surface requires the domain hash *plus* a user token; the domain hash is a
   server-side secret a browser never holds, so a stolen user access token by
   itself could not drive org management. After this change, one sessionStorage
   token alone is sufficient for cross-org rename, member role changes, team
   management, invitation handling — a material widening that the design never
   states as such (it only argues the *shape* of the lane). The 60-minute TTL
   and per-request `tokenVersion` check mitigate replay after revocation, not
   theft-in-window. Require two compensations in the design before Phase 2
   ships: (a) an explicit threat-model paragraph making XSS in `/account` the
   primary attack surface and pointing at the CSP/asset rules as the controls
   that must not regress; (b) step-up authentication (fresh `iat`, e.g.
   ≤ 10 minutes since login, or current password) for the destructive lane
   operations — transfer ownership, org delete, and role escalation to
   owner/admin — the same way §9.4 step-ups password change. "Any product UI
   already allows this" is not a defence: product UIs are one-org surfaces
   fronted by a backend holding the second secret; this portal is the first
   place one browser-held token spans the whole directory.

2. **§9.8 / Q4 — the lane substitutes the account config's grant table for the
   origin domain's, and §11 Q4 mischaracterises this as a UI-fidelity issue.**
   "The same rule cross-product user mode applies today (the calling domain's
   config governs)" is inaccurate: on the lane the calling config is always
   `ACCOUNT_CONFIG_JWT` with `LEGACY_DEFAULT_ROLE_GRANTS`, including for
   product-created orgs whose own domain config defines a *more restrictive*
   grant table or extra roles. Legacy default grants are generous; a member
   whose product config strips `teams.manage` can regain it through the
   portal. That is an authorisation boundary change, not a vocabulary mismatch.
   Until the Phase 4 `ClientDomainConfigSnapshot` lands, the design must either
   restrict the lane to orgs created in the portal, or explicitly document and
   get sign-off that the account config's grant table is a *floor* every
   product domain inherits for portal traffic.

3. **§4.5 / §9.8 — confused-deputy risk between the token's org claim and the
   route's `:orgId` is asserted away, not designed against.** The design says
   the lane "authorises by live ACTIVE membership rather than the token's org
   claim" but never states the mechanical guarantee: the composed guard must
   (a) fully re-derive role from the database for the route's `:orgId`,
   (b) overwrite or null out the request org context built from `claims.org`
   so that no downstream service (`requireOrgCapability`,
   `hasWorkspaceCapability`, audit rows, anything reading `request.config`'s
   org arm) ever authorises against the mint-time claim, and (c) run before any
   code path that touches `claims.org`, since an account token's claims may not
   even carry an org claim and anything reading it unguarded will either 403
   or crash. Add the explicit invariant and a test matrix: token minted in
   org-context A used against org B where the user holds a *higher* role in A
   than in B — every write must be denied at B's level.

4. **§9.8 — the lane must preserve existence-indistinguishable errors.** The
   existing guard answers non-member as `403 INSUFFICIENT_ORG_ROLE` regardless
   of whether the org exists. A live-membership guard that looks the org up
   first can easily diverge — `404` for unknown org, `403` for non-member —
   which turns every authenticated portal user into an org-existence oracle
   (orgIds are UUIDs, so severity is capped, but the regression is free to
   introduce and invisible in the design). Pin the status codes: nonexistent
   org, non-member org, and non-ACTIVE membership must be indistinguishable,
   exactly as today.

5. **§9.6 — the `/2fa/*` account arm never says what proof `/2fa/disable`
   requires.** Today those endpoints demand `configVerifier` +
   `X-UOA-Access-Token`; on the lane the design only says "account arm when
   `request.accountSession` is set" and widens the policy. If the lane form of
   disable accepts the bearer alone, a stolen 60-minute token — precisely the
   threat §8.2 tells the user to defend against with **Sign out everywhere** —
   silently removes the second factor, after which password change and
   everything else collapse to one factor. The design must state that the lane
   form of `/2fa/disable` (and `/2fa/setup` re-enrolment) retains a step-up
   proof (password or TOTP) at least as strong as the existing endpoint, and
   add a test for bearer-only disable being refused.

## NON-BLOCKING

- **§4.4 — `resolveAccessTokenContext` re-keying is a breaking change for any
  other config URL on the admin domain** (previously they all got the admin
  secret; now they 500 `FIRST_PARTY_CONFIG_UNKNOWN`). The design asserts the
  admin config is the only one; verify that in code before merging, or the
  change fails closed in a way that will page someone.
- **§8.3(3) — `twoFaPolicy` coupling is documented as a fact but only the
  allowlist got a pre-flight question (Q3).** Setting the auth-host domain
  policy to `REQUIRED` to protect portal users also forces 2FA on every
  `/admin` sign-in, and vice versa. Make it Q3b with an explicit owner
  decision.
- **§1 vs §4.2/§9.4 — "never Google-only" contradicts `enabled_auth_methods`
  including `google` and the whole social-only "Set a password" flow.** Either
  Google-only accounts can sign in at `/account` (then fix §1) or they cannot
  (then §9.4's social-only path is dead code). Contradictions in a security
  doc get exploited by implementers picking the wrong reading.
- **Q1 — `allow_registration: true` on the auth-host domain creates a public
  registration surface on the SSO origin itself.** The design defers the
  decision but not the abuse posture (bot registration, disposable emails
  farming accounts that can then be invited into orgs). Decide before Phase 1;
  the config value is not the decision.
- **§9.4 — confirm `verifyTwoFactorForLogin` semantics cover the enrolled
  method set.** If UOA supports email-code as a 2FA method, step 3 as written
  either bypasses it or bricks password change for those users; if TOTP-only,
  say so in the design.
- **§9.4 / Q6 — no password-changed notification email in v1.** The reset
  precedent already has this gap, but the portal makes credential rotation a
  one-click self-service action, which raises the value of the signal. Move Q6
  up the queue, not down.
- **§9.1 — `hasPassword` and `twoFaEnabled` in `/account/me`.** Own-data
  disclosure, acceptable, but it hands a session thief a targeting map (which
  accounts skip step 2/3 of §9.4). Worth one sentence of justification in the
  doc; no change required.
- **§8.3(1) — the bootstrap `503` leaks deployment state** (no superuser yet)
  to unauthenticated callers, and its body names an internal code. Generic
  body is claimed; keep the internal code out of the public schema the way
  other internal codes are handled.
- **§8.5 — password-change limiter 5/15 min per user id locks a legitimate
  user out after five typos of their own current password.** Availability
  nit; consider a slightly more forgiving per-user bucket with the IP bucket
  as the real brake.
- **Phase 5 — refresh cookie** is out of v1, but if it lands: `Path=/account/
  token` cookies ride every same-origin request to that path only — fine —
  yet logout and the bootstrap `503` path must both clear the cookie, or a
  post-revocation refresh attempt can resurrect a family the user was told is
  dead. Stated now because retrofitting is when this gets missed.

## What the design gets right — do not undo

- **§4.4 two-secret, two-`client_id` split with checks in both directions.**
  `requireAdminSuperuser` gaining the `client_id === 'admin:<domain>'` assert
  is backward-compatible hardening that structurally prevents the
  superuser-signs-in-at-/account escalation; the symmetric account guard
  prevents admin tokens riding the lane. The `account:<domain>` /
  `admin:<domain>` claim prefix is the load-bearing piece of the whole design.
- **§4.4 exact `config_url` string equality on `POST /account/token`.** Given
  the shared domain (fact 3), a domain check alone would let the account
  endpoint exchange codes against the admin config; the exact-string check is
  the correct response to the config-domain rule, and `FIRST_PARTY_CONFIG_
  UNKNOWN` failing closed for unknown first-party URLs is right.
- **§8.3(1) bootstrap `503`.** Without it, "first user on the domain becomes
  SUPERUSER" + "registration allowed" means whoever finds a fresh deployment
  first owns the platform. Closing it at the config/token endpoints is exactly
  where the race lives.
- **§9.4 password-change core.** `lockAndAssertGlobalAuthenticationEpoch`
  under the user-global lock, dummy-hash flat timing, TOTP step-up with
  counter replay protection, same-transaction `revokeAllRefreshTokensForUser`
  + `bumpUserTokenVersion` including the caller's own token, and only
  `PASSWORD_POLICY_VIOLATION` surviving as a public code. This is the same
  consequence email-token reset applies, correctly identified and correctly
  copied.
- **No refresh token in the browser, ≤ 60-minute session, `tokenVersion`
  verified against the database on every `requireAccountSession` call.** The
  §8.2 stolen-session story actually works as written: sign-out-everywhere
  kills the token on its next request, not at expiry.
- **§9.6 resolving 2FA policy across all ACTIVE orgs.** The alternative —
  portal shows OPTIONAL while an org requires REQUIRED — is a UI lie that
  becomes a policy-bypass complaint later; computing the strongest policy is
  the honest direction, and scoping the change to account arms only protects
  product callers from behaviour change.
- **§9.7 reusing `acceptTeamInviteWithinTransaction` / `declineTeamInviteFor
  User` verbatim**, including their "addressed to the caller's email" check
  and generic `400` for every failure class (unknown / foreign / expired /
  revoked). No new acceptance logic, no new enumeration surface.
- **§1/§9.10 refusals:** no member-by-id surface, no user search, no billing
  reach into product app-key territory, no email change, `backend_org_
  management` forbidden at config startup. Every refusal closes an escalation
  path a "just let the portal do it" design would have opened.
- **§4.6/§8.6 same-origin api-client, avatar bytes as object URLs, no
  third-party scripts, helmet parity with admin.** The avatar-via-`<img>`
  point (bearer can't ride an img URL) shows the threat model was actually
  thought through at the browser boundary, which is what makes finding 1
  fixable rather than fatal.
