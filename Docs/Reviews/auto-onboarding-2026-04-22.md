# Security & Architecture Review — Auto-Onboarding

**Feature:** `feature/auto-onboarding` → merged to `main` (commit `080f996`), live in production
**Date:** 2026-04-22
**Reviewers:** Claude sub-agent (code-reviewer), Codex (gpt-5.4 xhigh), Gemini, 12× Max (Claude Opus). Every finding below was verified against real code before inclusion.

---

## Verdict

No remote-exploitable vulnerability. Seven HIGH findings violate real invariants (one-shot claim, host binding, audit completeness, fail-closed on DB error). Cryptographic core, RBAC gates, SSRF IP guards, and data-model migrations are sound.

**Status (2026-04-22):** All 7 HIGH findings fixed. H1, H2, H4, H5, H6, H7 landed earlier in the day; H3 (rotate → claim flow) landed last.

---

## Tier 1 — HIGH (fix before next partner onboards)

### H1. Claim-token double-POST race leaks `client_secret` twice
**File:** `API/src/services/integration-claim.service.ts:159-182`
**Bug:** `consumeClaim` does `findUnique` → decrypt → `update(usedAt)` with no row lock and no `WHERE usedAt IS NULL` condition. Two concurrent POSTs in the same few-ms window both pass the JS `usedAt` check, both decrypt, both return the plaintext secret; the second `update` silently overwrites.
**Fix:** Change the update to `updateMany({ where: { id, usedAt: null }, data: {...} })` and treat `count === 0` as "already consumed". Decrypt only after the conditional write succeeds. Or wrap in `SELECT ... FOR UPDATE` via raw SQL.

### H2. Cross-host redirects bypass `domain ↔ jwks_url` host binding
**Files:** `auto-onboarding.service.ts:154`, `jwks-fetch.service.ts:92-103`, `config-fetch.service.ts:119-138`
**Bug:** `assertJwksHostMatchesDomain` checks the *initial* URL only. `fetchPartnerJwks` then follows up to 3 redirects to any public HTTPS host. An open redirect on the partner's domain lets an attacker host the JWKS on attacker.com while the host-equality check still passes. Same pattern in the config fetcher.
**Fix:** After each redirect hop, re-run `assertJwksHostMatchesDomain(redirectUrl, domain)`. Or refuse redirects entirely on the JWKS path — JWKS URLs should be stable.

### H3. Secret rotation bypasses the claim flow (spec deviation) — FIXED
**Files:** `API/src/routes/internal/admin/domains.ts`, `API/src/services/domain-secret.service.ts`, `API/src/services/integration-claim.service.ts`, `Admin/src/pages/SecretsPage.tsx`
**Bug:** Spec §4.7 + §6.3 requires rotation to (1) generate new secret, (2) email claim link to partner, (3) only deactivate old secret after claim. Prior code returned the raw secret to admin and immediately deactivated the old one. Partner was never emailed.
**Fix (2026-04-22):** `/internal/admin/domains/:domain/rotate-secret` now mirrors the accept-then-claim pattern. `rotateAdminDomainSecret` finds the most recent ACCEPTED integration request for the domain, deletes any unused outstanding claim, mints a fresh rotation claim token tagged with the `ClientDomain.id`, and emails the claim link to `contact_email`. Raw secret is never surfaced to the admin. `consumeClaim` was extended to — when the token carries `clientDomainId` — atomically deactivate the previously active `ClientDomainSecret` and insert the new one in the same transaction as marking the token used. If the partner never claims, the old secret stays live. Migration `20260422131343_add_claim_token_client_domain_fk` adds the `client_domain_id` column with `ON DELETE CASCADE`. Admin UI now displays a dispatch-status confirmation instead of revealing the secret. Regression tests: `rotateAdminDomainSecret` (404, DOMAIN_HAS_NO_CLAIM_CONTACT, no secret activation at rotate time, claim tagged with `clientDomainId`), `consumeClaim` rotation-on-consume (old secret deactivated + new active row inserted atomically).

### H4. Audit logs written outside the mutation transaction
**Files:** `integration-requests.ts:150-173`, `domain-jwks.ts:84-91`, `integration-requests.ts:102-109`
**Bug:** `$transaction` commits mutation → process crashes → `writeAuditLog` never runs → state change has no audit row. Spec §4.5 step 6 requires audit-in-transaction.
**Fix:** Pass the `tx` client into `writeAuditLog` and call it *inside* the `$transaction` callback.

### H5. Missing audit logs on 3 domain-admin endpoints
**File:** `API/src/routes/internal/admin/domains.ts:79, 95, 101`
**Bug:** `POST /internal/admin/domains`, `PUT /internal/admin/domains/:domain`, and `POST /internal/admin/domains/:domain/rotate-secret` have zero audit writes. Rotate-secret is the worst — high-sensitivity, no trace. Action names `domain.disabled`, `domain.enabled`, `domain.secret_rotated` are already defined in the union but never emitted.
**Fix:** Add `writeAuditLog` calls (inside the same transaction per H4).

### H6. Fire-and-forget email silently burns claim tokens
**File:** `API/src/routes/internal/admin/integration-requests.ts:108-116, 157-161, 187-191`
**Bug:** `acceptIntegrationRequest` returns 200, then `dispatchClaimEmail` fires async and unawaited. Only a `logger.error` on SMTP/SES failure. Claim token is persisted but partner never gets the link. Schema has no `claim_email_delivered_at` column, no retry, no admin-visible failure state.
**Fix:** Add `claim_email_delivered_at` column, retry job, and surface pending-delivery state in the admin UI. (Short-term workaround: await the send inside the route handler and roll back the transaction on failure.)

### H7. Concurrent accept TOCTOU produces unhandled 500
**File:** `integration-accept.service.ts:83, 96-100`
**Bug:** Two concurrent `/accept` calls on the same PENDING row both pass the status check, both try to create `client_domain`, one hits the unique constraint, Prisma throws `P2002` as an uncaught 500.
**Fix:** Catch `P2002` around the create and re-throw `DOMAIN_ALREADY_EXISTS`, or use serializable isolation.

---

## Tier 2 — MED (fix before partner scale)

| # | Finding | File |
|---|---------|------|
| M1 | No rate limit on public claim routes (`/integrations/claim/:token`, `/confirm`) — allows DB probing | `routes/integrations/claim.ts:48, 63` |
| M2 | No rate limit on `/auth` auto-discovery egress. Per-domain dedup bounds repeated fetches, but unique-domain campaigns still allow many outbound fetches | `config-verifier.ts:187-201`, `auth/entrypoint.ts:17` |
| M3 | `findJwkByKidDb` looks up by global `kid` — not domain-scoped. Domain A's active key can validate domain B's config before later domain-secret checks | `client-jwk.service.ts:129-140`, `config.service.ts:378-387` |
| M4 | DB-error fail-open: `.catch(() => null)` at `config.service.ts:379` falls through to legacy `CONFIG_JWKS_URL` | `config.service.ts:379` |
| M5 | Concurrent resend creates multiple valid unclaimed tokens | `integration-accept.service.ts:195-225` |
| M6 | `upsertPendingIntegrationRequest` TOCTOU — partial unique index surfaces as 500 on concurrent partner retries | `integration-request.service.ts:73-128` |
| M7 | No per-IP / per-domain cap on auto-discovery writes — sustained campaign can flood PENDING rows | `integration-request.service.ts:115-128` |
| M8 | `PUBLIC_BASE_URL` can fall back to `http://` — claim-link scheme not enforced HTTPS in env validation | `config/env.ts:37-39` |
| M9 | `.well-known/jwks.json` cached 5min, no purge on admin add/deactivate | `config-jwks.ts:27-50` |
| M10 | Missing index + FK on `client_domain_integration_requests.client_domain_id` | `migration.sql:32` |
| M11 | Admin UI Modal has no Escape handler and no focus trap (`onMouseDown={onClose}` only) | `Admin/src/components/ui/Modal.tsx:21-25` |
| M12 | 4/5 admin mutations missing `onError` rollback (accept/decline/resend/delete/deactivate) — only `addMutation` has one | `IntegrationRequestsPage.tsx:222-238` |
| M13 | JWK form validates presence only; no base64url check on `n`/`e`, no min 2048-bit RSA key size | `DomainSigningKeysSection.tsx:119-138` |
| M14 | Missing tests: concurrent accept, parallel claim-confirm, email-send failure, malformed JWKS shapes (`{keys: null}`, `{keys: "x"}`) | `tests/integration/` |

---

## Tier 3 — LOW (defer / polish)

- **L1** DNS rebinding window between resolve and connect. IP-pinning via `createPinnedAgent` (`ssrf.ts:203-212`) mitigates post-resolve swap. Minor.
- **L2** SES email flood on bulk admin accept — requires admin creds, auditable.
- **L3** Modal has `aria-label={title}` but not `aria-labelledby` pointing to the `<h2>`. A11y polish.
- **L4** `AdminAuditLog` append-only by convention, not by PG revoke. Harden if paranoid.

---

## What's solid

- **AES-256-GCM envelope**: HKDF-SHA256 KEK from `SHARED_SECRET`, CSPRNG IV, auth tag validated, atomic null on consume
- **SSRF IP guards**: full IPv4 + IPv6 private/reserved/multicast + CGNAT + IPv4-mapped coverage; 5s end-to-end timeout; 64 KiB cap; 3-redirect cap; pinned-IP agent
- **RBAC**: all 10 new admin endpoints wrap `requireAdminSuperuser` (bearer → role=superuser → domain=ADMIN_AUTH_DOMAIN → DB SUPERUSER row)
- **Host-equality on initial URL**: trailing dots, case, userinfo, ports, IP literals, WHATWG `#@` quirk — all safe (separate redirect-chain gap covered by H2)
- **Decline semantics**: no email to partner, DECLINED blocks re-submission, no enumeration leak
- **Admin UI rendering**: all attacker-controlled fields React-escaped; no unsafe HTML injection path
- **Migration FK cascades**: `client_domain_jwks → client_domains` and `integration_claim_tokens → integration_requests` both CASCADE correctly
- **`sweepExpiredClaims` cron**: registered in `app.ts:109-124`, runs every 6h
- **Claim error page**: identical generic page for `missing`/`expired`/`already_used` states

---

## Execution order

1. **H1** — claim-token race. Single-file conditional `updateMany`. Minutes.
2. **H4 + H5** — audit inside tx + 3 missing audit calls. Bundle.
3. **H2** — redirect host re-binding. Re-validate after each hop, or refuse redirects on JWKS path.
4. **H7** — catch P2002 on accept.
5. **H6** — claim-email reliability: `claim_email_delivered_at` + retry.
6. **H3** — rotate → claim flow refactor. Largest of the HIGHs.
7. **Tier 2 batch** — rate limits (M1, M2), domain-scoped JWK lookup (M3), fail-closed on DB error (M4), resend lock (M5), accept TOCTOU (M6), per-IP write cap (M7), HTTPS enforcement (M8), JWKS cache headers (M9), index + FK (M10), admin UI (M11–M13), tests (M14).

Tier 1 is ~1–2 days. Tier 2 is another ~2–3 days.
