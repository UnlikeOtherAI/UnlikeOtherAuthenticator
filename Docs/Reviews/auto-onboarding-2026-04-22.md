# Security & Architecture Review — Auto-Onboarding

**Feature:** `feature/auto-onboarding` → merged to `main` (commit `080f996`), live in production
**Date:** 2026-04-22
**Reviewers (18):** Claude sub-agent (code-reviewer), Codex (gpt-5.4 xhigh), Gemini, 12× Max (Claude Opus via `max` CLI). 1 reviewer produced no usable output.
**Convergence signal:** Each HIGH finding below was reported by >= 2 independent reviewers unless flagged `[MAX-ONLY]` — those require verification before action (Max hallucinates).

---

## Verdict

**Not production-clean.** No remote-exploitable vulnerability found by any reviewer, but **seven HIGH findings** violate invariants we care about (one-shot claim, host binding, audit completeness, fail-closed on DB error). Cryptographic core, RBAC gates, SSRF IP guards, and data-model migrations are sound.

---

## Tier 1 — Fix before next partner onboards (HIGH)

### H1. Claim-token double-POST race leaks `client_secret` twice
**Reported by:** Max #6 [CRIT], Codex [HIGH], Claude sub-agent, Max #15 (as test gap)
**File:** `API/src/services/integration-claim.service.ts:159-182`
**Bug:** `consumeClaim` does `findUnique` -> decrypt -> `update(usedAt)` with no row lock and no `WHERE usedAt IS NULL` condition. Two concurrent POSTs in the same few-ms window both pass the JS `usedAt` check, both decrypt, both return the plaintext secret; the second `update` silently overwrites.
**Fix:** Change the update to `updateMany({ where: { id, usedAt: null }, data: {...} })` and treat `count === 0` as "already consumed". Decrypt only after the conditional write succeeds. Or wrap in `SELECT ... FOR UPDATE` via raw SQL.
**Tests missing:** No concurrent double-POST test (Max #15).

### H2. Cross-host redirects bypass `domain <-> jwks_url` host binding
**Reported by:** Codex [HIGH]
**Files:** `auto-onboarding.service.ts:154`, `jwks-fetch.service.ts:92-103`, `config-fetch.service.ts:119-138`
**Bug:** `assertJwksHostMatchesDomain` checks the *initial* URL. `fetchPartnerJwks` then follows up to 3 redirects to any public HTTPS host. An open redirect on the partner's domain lets an attacker host the JWKS on attacker.com while the host-equality check still passes. Same pattern in the config fetcher. (Max #3 examined WHATWG URL quirks on the *initial* URL and found them all safe — but did not examine redirect chains, which is where the vector lives.)
**Fix:** After each redirect hop, re-run `assertJwksHostMatchesDomain(redirectUrl, domain)`. Or refuse redirects entirely on the JWKS fetch path — JWKS URLs should be stable.

### H3. Secret rotation bypasses the claim flow (spec deviation)
**Reported by:** Max #14, Codex [HIGH]
**Files:** `API/src/routes/internal/admin/domains.ts:101-111`, `domain-secret.service.ts:156-187`, `Admin/.../SecretsPage.tsx:88-99`
**Bug:** Spec section 4.7 + 6.3 requires rotation to (1) generate new secret, (2) email claim link to partner, (3) only deactivate old secret after claim. Current code returns the raw secret to admin and immediately deactivates the old one. Partner is never emailed.
**Fix:** Rewrite `/internal/admin/domains/:domain/rotate-secret` to mirror the accept-then-claim pattern.

### H4. Audit logs written outside the mutation transaction
**Reported by:** Max #4 [HIGH], Max #5 [HIGH], Codex [MED]
**Files:** `integration-requests.ts:150-173`, `domain-jwks.ts:84-91`, `integration-requests.ts:102-109`
**Bug:** `$transaction` commits mutation -> process crashes -> `writeAuditLog` never runs -> state change has no audit row. Spec section 4.5 step 6 requires audit-in-transaction.
**Fix:** Pass the `tx` client into `writeAuditLog` and call it *inside* the `$transaction` callback.

### H5. Missing audit logs on 3 domain-admin endpoints
**Reported by:** Max #5 [CRIT], Max #14, Codex [MED]
**File:** `API/src/routes/internal/admin/domains.ts:79, 95, 101`
**Bug:** `POST /internal/admin/domains`, `PUT /internal/admin/domains/:domain`, and `POST /internal/admin/domains/:domain/rotate-secret` have zero audit writes. Rotate-secret is the worst — high-sensitivity, no trace. Audit action names `domain.disabled`, `domain.enabled`, `domain.secret_rotated` are already defined in the union but never emitted.
**Fix:** Add `writeAuditLog` calls (inside the same transaction per H4).

### H6. Fire-and-forget email silently burns claim tokens `[MAX-ONLY]`
**Reported by:** Max #7 [HIGH]
**File:** `API/src/routes/internal/admin/integration-requests.ts:108-116, 150-161`
**Bug:** `acceptIntegrationRequest` returns 200, then `dispatchClaimEmail` fires async. If SMTP/SES throws, the claim token is already persisted but the partner never gets the link. Admin sees success, token expires unused, no compensating action.
**Fix:** Either (a) await the email inside the route handler and roll back the transaction on failure, or (b) add a `claim_email_delivered_at` column and a retry job, and surface the pending state in the admin UI.

### H7. Concurrent accept TOCTOU produces unhandled 500
**Reported by:** Max #4 [HIGH], Gemini [HIGH]
**File:** `integration-accept.service.ts:83, 96-100`
**Bug:** Two concurrent `/accept` calls on the same PENDING row both pass the status check, both try to create `client_domain`, one hits the unique constraint, Prisma throws `P2002` as an uncaught 500.
**Fix:** Either use `Prisma.TransactionIsolationLevel.Serializable`, or catch `P2002` in a `try/catch` around the create and re-throw `DOMAIN_ALREADY_EXISTS`.

---

## Tier 2 — Fix before partner scale (MED)

| # | Finding | Reviewer | Corroboration | File |
|---|---------|----------|---------------|------|
| M1 | No rate limit on public claim routes (`/integrations/claim/:token`, `/confirm`) — allows DB probing | Claude sub-agent, Codex [LOW] | 2 | `routes/integrations/claim.ts:48, 63` |
| M2 | No rate limit on `/auth` auto-discovery egress — botnet can weaponize us as DDoS vector against any `jwks_url` | Max #11 [CRIT], Codex [MED] | 2 | `config-verifier.ts:187-201`, `auth/entrypoint.ts:17` |
| M3 | `sweepExpiredClaims` exists but is never registered as a cron `[MAX-ONLY]` | Max #6 [CRIT] | 1 | `integration-claim.service.ts:219-235` |
| M4 | Per-domain signing keys aren't actually domain-scoped — `findJwkByKidDb` looks up by global `kid`, allowing domain A's key to verify domain B's config | Codex [MED] | 1 | `client-jwk.service.ts:129-140`, `config.service.ts:378-387` |
| M5 | DB-error fail-open in config verification falls back to legacy `CONFIG_JWKS_URL` `[MAX-ONLY]` | Max #8 [HIGH] | 1 | `config.service.ts:379` |
| M6 | Concurrent resend creates multiple valid unclaimed tokens | Codex [MED], Gemini [MED] | 2 | `integration-accept.service.ts:195-225` |
| M7 | Raw `upsertPendingIntegrationRequest` TOCTOU — partial unique index surfaces as 500 on concurrent partner retries | Gemini [HIGH] | 1 | `integration-request.service.ts:73-128` |
| M8 | `PUBLIC_BASE_URL` can fall back to `http://` in dev — claim-link scheme not enforced HTTPS in env validation | Codex [MED] | 1 | `config/env.ts:37-39` |
| M9 | `.well-known/jwks.json` cached 5min, no purge on admin add/deactivate | Max #8, Codex | 2 | `config-jwks.ts:27-50` |
| M10 | Missing index on `client_domain_integration_requests.client_domain_id` + no FK | Max #10, Codex | 2 | migration.sql:32 |
| M11 | Per-domain / per-IP cap missing on auto-discovery writes — sustained campaign can flood PENDING rows `[MAX-ONLY]` | Max #11 | 1 | `integration-request.service.ts:115-128` |
| M12 | Admin UI: no rollback on failed mutation, no focus trap, no Esc-to-close, no RSA key-size (2048-bit) validation `[MAX-ONLY]` | Max #13 | 1 | `IntegrationRequestsPage.tsx`, `Modal.tsx`, `DomainSigningKeysSection.tsx` |
| M13 | Test coverage gaps: concurrent accepts, concurrent claim POST, malformed JWKS shapes (`{keys: null}`, `{keys: "x"}`), email-send failure `[MAX-ONLY]` | Max #15 | 1 | tests |
| M14 | Migration not atomic: ENUM + 4 tables run outside explicit `BEGIN...COMMIT` `[MAX-ONLY]` | Max #10 | 1 | migration.sql:1, 82 |

---

## Tier 3 — LOW

- L1. DNS rebinding window (5s) between `resolvePublicDestinations` and `connect` — Max #2 `[MAX-ONLY]`. 5s timeout caps exposure.
- L2. Timing oracle on IV-length pre-check before tag verification — Max #1 `[MAX-ONLY]`. Requires DB read access to exploit.
- L3. `AdminAuditLog` has no UPDATE/DELETE path — append-only by convention, not schema constraint — Max #5. Fine.
- L4. SES flood on bulk admin accept — Max #11 `[MAX-ONLY]`. Requires admin creds.
- L5. No timing-safe tokenHash compare (`claim.service.ts:135`) — Max #6 `[MAX-ONLY]`. Hash is CSPRNG 192-bit; practically moot.
- L6. Admin UI missing `aria-labelledby` on modal, no RSA min key size check — Max #13 `[MAX-ONLY]`.

---

## What's solid (OK, widely confirmed)

- **AES-256-GCM envelope**: HKDF-SHA256 KEK from `SHARED_SECRET`, CSPRNG IV, tag validated, atomic null on consume (Max #1, Gemini)
- **SSRF IP guards**: full IPv4 + IPv6 private/reserved/multicast + CGNAT + IPv4-mapped coverage; 5s end-to-end timeout; 64 KiB cap; 3-redirect cap; pinned-IP agent (Max #2)
- **RBAC**: all 10 new admin endpoints wrap `requireAdminSuperuser` (bearer -> role=superuser -> domain=ADMIN_AUTH_DOMAIN -> DB SUPERUSER row) (Max #12, Codex)
- **Host-equality on initial URL**: trailing dots, case, userinfo, ports, IP literals, WHATWG `#@` quirk — all safe (Max #3). *But see H2 for the redirect-chain gap.*
- **Decline semantics**: no email to partner, DECLINED blocks re-submission, no enumeration leak (Max #9, Gemini, Max #14)
- **Admin UI rendering**: no unsafe HTML injection path, all attacker-controlled fields React-escaped (Max #13)
- **Migration FK cascades**: `client_domain_jwks -> client_domains` and `integration_claim_tokens -> integration_requests` both CASCADE correctly (Max #10)
- **Claim error page**: identical generic page for `missing`/`expired`/`already_used` states (Max #9)

---

## Reviewer coverage map

| Reviewer | Area | File |
|----------|------|------|
| Max #1 | Claim crypto (AES-GCM, HKDF, IV, tag) | `/tmp/uoa-review/01-claim-crypto.md` |
| Max #2 | SSRF + jwks-fetch | `/tmp/uoa-review/02-ssrf.md` |
| Max #3 | Host-equality + WHATWG URL quirks | `/tmp/uoa-review/03-host-equality.md` |
| Max #4 | Accept transaction atomicity | `/tmp/uoa-review/04-accept-tx.md` |
| Max #5 | Audit log completeness | `/tmp/uoa-review/05-audit-log.md` |
| Max #6 | Claim lifecycle + expiry | `/tmp/uoa-review/06-claim-lifecycle.md` |
| Max #7 | Email delivery | `/tmp/uoa-review/07-email.md` |
| Max #8 | JWKS cache invalidation | `/tmp/uoa-review/08-jwks-cache.md` |
| Max #9 | Error-message enumeration | `/tmp/uoa-review/09-error-enumeration.md` |
| Max #10 | Migration SQL safety | `/tmp/uoa-review/10-migration.md` |
| Max #11 | Rate limiting + egress | `/tmp/uoa-review/11-rate-limit.md` |
| Max #12 | RBAC + admin middleware | `/tmp/uoa-review/12-rbac.md` |
| Max #13 | Admin UI security | `/tmp/uoa-review/13-admin-ui.md` |
| Max #14 | Spec conformance | `/tmp/uoa-review/14-spec-conformance.md` |
| Max #15 | Test coverage | `/tmp/uoa-review/15-test-coverage.md` |
| Codex | All 8 areas (A-H) | `/tmp/uoa-review/16-codex.md` (end of file) |
| Gemini | Architecture + flow | saved as `security-review-auto-onboarding-2026-04-22.md` at repo root (untracked) |
| Claude sub-agent | Top 10 risks + top 5 ranked | inline conversation output (not file) |

---

## Recommended execution order

1. **H1 (claim-token race)** — single-file surgical fix; change `update` to conditional `updateMany`. Minutes of work.
2. **H4 + H5 (audit inside tx + missing audits)** — bundle: pass `tx` into `writeAuditLog`, add the three missing calls.
3. **H2 (redirect host re-binding)** — refuse redirects on `fetchPartnerJwks` path or re-validate each hop.
4. **H7 (P2002 catch on accept)** — wrap the transaction's `create` in a try/catch.
5. **H6 (email reliability)** — needs verification (MAX-ONLY), then add `claim_email_delivered_at` column + retry job.
6. **H3 (rotate -> claim flow)** — larger refactor; matches accept-then-claim pattern already built.
7. **Tier 2 batch** — rate limits (M1, M2), cron registration (M3 after verify), domain-scoped JWK lookup (M4), fix fail-open (M5 after verify).

Estimated scope for Tier 1: 1-2 days of focused work, all within existing files. No new dependencies.

---

## Max-only claim verification (post-review, 2026-04-22)

Max agents occasionally hallucinate. Each `[MAX-ONLY]` claim was verified against real code using parallel Explore agents.

### CONFIRMED (keep in fix plan)

| ID | Claim | Evidence |
|----|-------|----------|
| H6 | `dispatchClaimEmail` truly fire-and-forget, no retry, no `claim_email_delivered_at` column | `integration-requests.ts:108-116, 157-161, 187-191`; schema lines 276-291 |
| M5 | `.catch(() => null)` at `config.service.ts:379` falls through to legacy `CONFIG_JWKS_URL` | Real code matches claim; fail-open confirmed |
| M11 | `upsertPendingIntegrationRequest` has no per-IP or per-domain write cap | `integration-request.service.ts:73-128`; only global /auth 60/min IP limit applies |
| M12a | Modal `onMouseDown={onClose}` only; no `onKeyDown` / Escape / focus trap | `Admin/src/components/ui/Modal.tsx:21-25` |
| M12b | 4/5 admin mutations missing `onError` (accept/decline/resend/delete/deactivate) | `IntegrationRequestsPage.tsx:222-238`; only `addMutation` has onError |
| M12c | JWK form validates kty/kid/n/e presence but NOT base64url nor min RSA key size | `DomainSigningKeysSection.tsx:119-138` |
| M13-1 | No concurrent accept test | `internal-admin-integration-requests.route.test.ts:281` sequential only |
| M13-2 | No parallel claim-confirm POST test | `integrations-claim.route.test.ts` sequential only |
| M13-4 | No email-send-failure test | Mock always resolves at line 19 |
| M14 | Migration has no explicit `BEGIN...COMMIT` | But Prisma wraps migrations in implicit tx — **practically mitigated** |
| L5 | `peekClaim` uses plain `findUnique` on tokenHash | Not timing-safe in theory; 192-bit hash makes brute-force infeasible — **practically irrelevant** |

### REJECTED (Max hallucinated — drop from fix plan)

| ID | Claim | Truth |
|----|-------|-------|
| M3 | `sweepExpiredClaims` has no cron | **It IS registered** at `API/src/app.ts:109-124`, runs every 6h via `setInterval`. Max #6 hallucinated. |
| L2 | Timing oracle on IV-length pre-check | All three error paths (IV len, tag len, GCM auth) throw identical `AppError('INTERNAL', 500, ...)`. No distinguishable timing or error. Max #1 overstated. |
| M2 CRIT severity | Unbounded DDoS amplification at 6000 req/min | **Per-domain dedup prevents repeated fetches.** `findOpenIntegrationRequest` at `config-verifier.ts:156-159` short-circuits on existing PENDING/DECLINED row before `fetchPartnerJwks`. Second attempt to same domain skips fetch. Codex's MED rating is correct. |
| M13-5 | SSRF edge-case tests missing | Missing from `jwks-fetch.service.test.ts` but covered in `config-fetch.service.test.ts` (IPv6, IPv4-mapped, DNS rebinding). Test *asymmetry* not *absence*. |

### PARTIAL (nuanced — revisit case-by-case)

| ID | Claim | Nuance |
|----|-------|--------|
| L1 | DNS rebinding 5s window | IP pinning via `createPinnedAgent` is real (`ssrf.ts:203-212`), mitigating post-resolve swap. 5s timeout claim could not be located by the verifier. |
| M12d | Modal missing `aria-labelledby` | Has `aria-label={title}` (functionally equivalent); `aria-labelledby` pointing to `<h2>` would be more semantic. LOW at most. |
| M13-3 | Malformed JWKS shapes untested | Some covered (non-JSON, private key, HTTP 500); missing `{keys: null}`, `{keys: "string"}`. Partial gap. |

---

## Final ground-truth fix plan (post-verification)

### Definitely fix (HIGH, all confirmed)

1. **H1** — Claim-token race: conditional `updateMany`. `integration-claim.service.ts:159-182`.
2. **H4 + H5** — Audit inside tx + add missing audits. `integration-requests.ts:150-173`, `domain-jwks.ts:84-91`, `domains.ts:79, 95, 101`.
3. **H2** — Redirect host re-binding. `jwks-fetch.service.ts:92-103`, `config-fetch.service.ts:119-138`.
4. **H7** — Catch P2002 on accept. `integration-accept.service.ts:96-100`.
5. **H6** — Email reliability. Add `claim_email_delivered_at` + retry job. (MAX-ONLY but confirmed real.)
6. **H3** — Rotate-secret → claim flow. `domains.ts:101-111` + `domain-secret.service.ts:156-187` + `SecretsPage.tsx`.

### Definitely fix (MED, all confirmed)

7. **M1** — Rate-limit `/integrations/claim/:token` + `/confirm`.
8. **M2** — Rate-limit `/auth` auto-discovery egress (MED severity, not CRIT — per-domain dedup already bounds this but a per-IP cap on unique-domain auto-discovery is still warranted).
9. **M4** — Scope `findJwkByKidDb` to domain.
10. **M5** — Replace `.catch(() => null)` with fail-closed behavior on DB error.
11. **M6** — Lock resend-claim or check recent-token-exists.
12. **M7** — Catch P2002 on `upsertPendingIntegrationRequest`.
13. **M8** — Validate `PUBLIC_BASE_URL` starts with `https://` in production.
14. **M9** — Drop `Cache-Control: max-age=300` on `.well-known/jwks.json`, or flush on admin JWK change.
15. **M10** — Add index + FK on `client_domain_integration_requests.client_domain_id`.
16. **M11** — Cap unique-domain auto-discovery writes per IP per hour.
17. **M12** — Admin UI: add Escape handler + focus trap to Modal, add `onError` to 4 mutations, add base64url + min 2048-bit RSA validation.
18. **M13** — Add concurrent accept test, concurrent claim-confirm test, email-failure test, remaining malformed-JWKS shape tests.

### Drop

- **M3** (cron registration): already done, Max hallucinated.
- **L2** (IV timing oracle): no oracle exists.
- **M2 CRIT severity claim**: downgrade to MED per Codex; per-domain dedup bounds the vector.
- **M13-5** (SSRF tests in jwks-fetch): already covered in config-fetch; duplication not required.

### Defer (LOW, worth noting)

- L1 DNS rebinding window — 5s timeout + IP pinning makes this minor; revisit if high-TTL exploits ever surface.
- L3 audit append-only — convention, not schema constraint. Add PG revoke if paranoid.
- L4 SES flood — admin-gated, low risk.
- L5 timing-safe tokenHash — 192-bit entropy makes this moot.
- L6 Modal `aria-labelledby` — a11y polish, not security.
- M14 migration atomicity — Prisma's implicit tx handles it.
