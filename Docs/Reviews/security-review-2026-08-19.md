# Security Review — 2026-08-19

Scope: `API/src/**`, `Auth/src/**`, `Admin/src/**`, `packages/**`, `API/prisma/**`,
`Dockerfile`, `docker/**`, `.github/workflows/**`.

Method, in three passes:

1. **Seven parallel auditors**, each given one perspective and one slice of the tree, each
   required to cite `path:line`, quote real code, and record what it checked that could have
   refuted the finding. Perspectives: tokens/cryptography; authentication flows; authorization
   and tenancy; the web attack surface (SSRF, redirects, uploads, output injection, DoS);
   billing integrity; the data layer, secrets and deployment; the two frontends.
2. **Three adversarial verifiers**, each handed reports it did not write, instructed to assume
   every finding was wrong until the code forced agreement, and to re-derive the attack path
   themselves. Verdicts: CONFIRMED / OVERSTATED / REFUTED / NOT-EXPLOITABLE-AS-DESCRIBED.
3. **Three reviewers of the fixes themselves**, on separate angles — security correctness,
   production blast radius, and whether the new tests would fail if the fix were reverted.

21 findings were raised. 15 survived verification, 4 were refuted or reclassified to None, and
2 were downgraded. Severity used throughout: **Critical** (exploitable without auth or breaks a
core invariant), **High** (exploitable with weak preconditions or breaks the spec), **Medium**
(hardening / defence in depth), **Low** (nit / future-proofing).

Nothing Critical or High survived verification. The one finding reported as High was downgraded
to Medium on the grounds that the attacker must already hold the credential the endpoint echoes.

---

## Fixed on this branch

| # | Finding | Severity | Where |
|---|---|---|---|
| 1 | `GET /domain/debug` returned the caller's live 64-hex domain-hash bearer as `client_id` | Medium | `routes/domain/debug.ts` |
| 2 | Confidential-assertion `jti` ledger was pruned at the same instant the verifier still accepted the assertion, so a replay inside the clock-skew window found no ledger row | Medium | `services/confidential-assertion-use.service.ts` |
| 3 | TOTP QR logo fetch was a full-read SSRF: no address validation, no redirect policy, no timeout, no size cap, and the fetched bytes were base64'd into the returned QR | Medium | `services/totp-qr.service.ts` |
| 4 | The auth diagnostic page rendered to any anonymous browser sending `Accept: text/html` to `/auth*`, disclosing the tenant's redirect allowlist, the config Zod issues, and a per-tenant config example built from attacker-supplied input | Medium | `middleware/error-handler.ts`, `services/auth-debug-page.service.ts` |
| 5 | The Admin UI shipped a one-click copy of the live superuser bearer, with a ready-to-run `curl`, mounted unconditionally | Medium | `Admin/src/components/DebugFab.tsx` |
| 6 | `script-src 'unsafe-inline'` applied to every response, disabling the control that would contain any future escaping regression | Medium | `app.ts`, `services/auth-ui.service.ts` |
| 7 | Every anonymous rate limiter keyed solely on `request.ip`, which `trustProxy: 1` takes from a client-supplied header | Low→Medium | `routes/auth/rate-limit-keys.ts`, `routes/avatar/public-team.ts` |
| 8 | Bridge tokens (`login_token`, `twofa_token`, `twofa_setup_token`) persisted in the address bar after being parsed | Low | `Auth/src/hooks/use-popup.tsx` |
| 9 | Every outbound email logged its recipient address in production | Low | `services/email.providers.ts` |
| 10 | `listOrganisationMembers` was the only member-read service with no actor membership check | Low | `services/organisation.service.members.ts` |
| 11 | The `inline_sign_in` branch was the one exit from `requestRegistrationInstructions` with no timing budget | Low | `services/auth-register.service.ts` |

## Refuted, or reclassified to no finding

- **Billing legacy audience accepts a path-only `aud`** — refuted. `createBillingAppKey` pins
  `actorAudience` to one exact constant, so the prefix check flagged as loose is dead-boundary
  code that no caller can reach.
- **Confidential-assertion consumption runs outside a transaction** — refuted; the premise was
  stale. `exchangeConfidentialSubjectToken` wraps the whole exchange in `runInTransaction` and
  passes that client through to the consume call.
- **Stripe webhook processes events while collection is disabled** — not a finding. The
  behaviour is specified in `Docs/deploy.md`, including the rationale that money which arrived
  must still be recorded, and every mutation it permits is bound to a pre-existing local record.
- **App-key `lastUsedAt` write is swallowed** — not a finding. The auth decision does not read
  it; no caller uses it for authorization.
- **`inline_sign_in` is an account-existence oracle** — not a vulnerability. The mode is an
  opt-in that a tenant enables in its own signed config, and the 409 is an explicit existence
  signal by design. Only the missing timing budget (item 11) was worth changing.
- **Password-reset request silently no-ops when the database is unreachable** — observability
  gap, not a security one.

## Deferred

Three verified findings were not fixed here because each needs a decision that is not the
auditor's to make. They are carried in `Docs/security-backlog.md` as B1 (rate-limit state is
per-process, so every budget divides by replica count), B2 (`BILLING_ACTOR_AUDIENCE_MODE` still
defaults to `warn`), and B3 (three team-invitation routes silently ignore a forwarded user
token). A fourth, B4, was raised by the review of the fixes rather than by the audit: the
domain-hash bearer is still an access-token claim and a plaintext `RefreshToken.clientId`
column, which contradicts the invariant that justifies fix #1.

## What the review of the fixes caught

Worth recording, because the fixes passed a full green suite before this pass ran.

- **Fix #6 broke inline styles.** `enableCSPNonces` appends a nonce to `style-src` as well as
  `script-src`, and a nonce makes `'unsafe-inline'` inert — three server-rendered pages shipped
  unstyled. The accompanying test asserted only on `script-src`, so it stayed green. The lesson
  generalises: a test written from the same mental model as the fix inherits its blind spot.
- **Fix #3 turned a cosmetic failure into an outage.** Refusing redirects is correct, but a
  logo URL that merely redirects apex-to-www then failed the entire 2FA enrolment response.
- **Two replay tests passed with the fix reverted** — proven by simulation, not by reading.
- **An unsalted digest is not a mask** when the input space is enumerable (fix #9).
- **A rate-limit circuit breaker set too low is itself a DoS primitive** (fix #7): at 10k/min
  per process, ~167 req/s from a single host tripped it for everyone.
- A production `SHARED_SECRET` entropy floor, added as a hardening, was **removed** after review:
  it failed at env-parse time, so a non-compliant deployed secret crash-loops the container, and
  the remediation is a coordinated rotation that invalidates every domain-hash bearer and every
  refresh token across the estate. The generation guidance stays in `Docs/deploy.md` as advice.

## Verified clean

Recorded because a negative result from a directed search has value at the next audit. Each was
probed specifically and the guard was found and read.

- **No algorithm confusion.** Every `jwtVerify` call site passes an explicit `algorithms`
  allowlist; the HS256 and RS256 user-access-token branches use strictly separate key material.
- **`SHARED_SECRET` never reaches a response, a JWKS document, a log line, or a debug page.**
- **Confidential-assertion replay across processes** is serialised by
  `@@unique([sourceDomain, jtiHash])`; two concurrent first-presentations resolve to one winner.
- **Every billing route's actor audience** matches its own path constant — all 22 endpoints
  checked against the closed `BILLING_ACTOR_ENDPOINTS` list, no drift.
- **Stripe webhook signature** is verified over the raw body before any state change.
- **`/internal/admin/*`** is uniformly behind the superuser guard; no route reachable without it.
- **No raw SQL interpolation** — every `$queryRaw` use is parameterised.
- **`login-session-use`** uses the same ledger shape as the confidential assertions but with zero
  clock tolerance, so the boundary bug in finding #2 does not transfer to it.
- **The avatar SSRF guard** (`fetchProviderAvatar`) pins the connection to the validated address,
  so DNS cannot be rebound between check and connect. It is the pattern finding #3 was fixed to.

## Note on the test baseline

Every auditor reported "pre-existing" typecheck errors and 7 failing billing tests. They were
neither pre-existing defects nor caused by any change here: `packages/billing-statement-protocol`
was simply unbuilt in the worktree. Building it cleared all of them. Worth knowing before the
next audit spends the same effort re-diagnosing it.
