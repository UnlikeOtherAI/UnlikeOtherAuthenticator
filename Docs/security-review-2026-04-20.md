# Security & Architecture Review — API + DB Schema

Date: 2026-04-20
Scope: `API/src/**`, `API/prisma/schema.prisma`, `API/prisma/migrations/**`
Method: Parallel exploration (3 agents), hand-validation of every claim against source, then external verifier pass (claude-code-guide, codex, gemini-cli, max swarm).
Hallucinations removed during validation pass are listed at the end.

Severity: **Critical** (exploitable w/o auth or breaks core invariant), **High** (exploitable with weak preconditions or breaks spec), **Medium** (hardening / defense in depth), **Low** (nit / future-proofing), **Info** (good practice noted).

Each finding is tagged VALIDATED (code-checked by orchestrator) or UNVERIFIED (from verifier pass, worth investigating but not confirmed).

---

## CRITICAL

### C1. No rate limiting on `/auth/login`, `/auth/register`, `/auth/reset-password`, `/2fa/verify` — VALIDATED
- **Location:** `API/src/routes/auth/login.ts:32-38`, `register.ts:20`, `reset-password.ts:28,54`, `API/src/routes/twofactor/verify.ts:26`
- **Evidence:** Each route's `preHandler` contains only `configVerifier`. `createRateLimiter` is only wired on `domain-mapping.ts` and the `org/*` routes.
- **Impact:** Unlimited password brute-force, unlimited TOTP brute-force (1,000,000 codes → worst case ~1M attempts), unlimited password-reset-email spam (email bombing + cost), unlimited registration (resource abuse + enumeration fuel).
- **Fix:** Apply `createRateLimiter` with per-IP and per-email keys on every unauthenticated sensitive endpoint. Suggested: login 5/15min per email+IP, register 5/hour per IP, reset 3/hour per email, 2FA verify 5/15min per userId. Use a distributed store (Redis) because rate-limiter.ts stores state in an in-process `Map` (`rate-limiter.ts:19`) and is bypassed by any horizontal scale-out.

### C2. Domain-hash bearer compared with `!==` instead of `timingSafeEqual` — VALIDATED
- **Location:** `API/src/middleware/domain-hash-auth.ts:76`
- **Evidence:**
  ```ts
  if (token !== expected) { throw new AppError('UNAUTHORIZED', 401); }
  ```
  Both sides are 64-char hex SHA-256 digests.
- **Impact:** Classic timing side-channel. The compared value IS the bearer token — recovering it gives full domain-level API access. Fixed-length strings reduce leak rate but V8's string compare short-circuits on first differing byte.
- **Fix:** `crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))` guarded by length check.

### C3. Authorization code not bound to `redirect_url` at exchange — VALIDATED
- **Location:** `API/src/services/token.service.ts:144-190` (`consumeAuthorizationCode`)
- **Evidence:** Code is stored with `redirectUrl` (line 125) but `consumeAuthorizationCode` only validates `domain` and `configUrl` (lines 168-170). `exchangeAuthorizationCodeForTokens` never checks that the redirect URL the client is exchanging from matches the one that was bound at issuance.
- **Impact:** RFC 6749 §4.1.3 violation. An attacker who steals an auth code (e.g. via referer leak, proxy log, rogue browser extension) can exchange it from any allow-listed redirect URL, expanding the interception surface.
- **Fix:** Pass `redirectUrl` through `exchangeAuthorizationCodeForTokens` → `consumeAuthorizationCode` and reject if `row.redirectUrl !== params.redirectUrl`.

### C4. No PKCE on OAuth authorization code flow — VALIDATED
- **Location:** `API/src/services/token.service.ts` (no `code_challenge`/`code_verifier` anywhere); `API/src/routes/auth/entrypoint.ts`, `social.ts`
- **Evidence:** grep for `code_challenge` / `code_verifier` / `S256` returns zero hits across `API/src`.
- **Impact:** Any client consuming this auth service from a browser, mobile app, or SPA is vulnerable to authorization-code interception (RFC 7636 threat model). The spec in `brief.md` section 22.13 describes the authorization code flow but does not mandate PKCE; it should.
- **Fix:** Accept `code_challenge` + `code_challenge_method=S256` on the entrypoint that issues codes, persist the challenge in `AuthorizationCode`, require `code_verifier` on `/auth/token-exchange`, reject mismatches generically. Make PKCE mandatory for public clients; optional but recommended for confidential.

### C5. Facebook social login accepts emails without provider verification — VALIDATED
- **Location:** `API/src/services/social/facebook.service.ts:128`
- **Evidence:**
  ```ts
  emailVerified: true,   // Facebook doesn't provide an explicit flag; treat presence as verified.
  ```
- **Impact:** `brief.md` 22.6 mandates provider-verified emails only. Facebook historically allows unverified emails on the Graph API. An attacker who registers a Facebook account with `victim@example.com` (unverified) can log in as that victim if they use the Facebook social path. Account takeover across identity providers.
- **Fix:** Either (a) drop Facebook as a supported provider (it has no reliable verified-email signal on the basic Graph API), or (b) follow the GitHub pattern — explicitly fetch the user's list of emails and require one marked verified by Facebook. Current behaviour is unsafe and contradicts the brief.

### C6. ScimToken and ScimGroupMapping declared in schema with no migration — VALIDATED
- **Location:** `API/prisma/schema.prisma:320-347`; `API/prisma/migrations/` (no entries)
- **Evidence:** `grep -r scim_token API/prisma/migrations` → zero hits. Last migration is `20260329090000_add_team_slugs`.
- **Impact:** `prisma.scimToken.*` and `prisma.scimGroupMapping.*` would crash at runtime against a real DB. If any code path references these models (even in a feature-flagged branch), the first hit is a 500. This is currently latent because SCIM is deferred (per memory + commit `e4375b9`), but the schema-to-DB mismatch breaks `prisma migrate status` and makes it unsafe to run migrations in prod.
- **Fix:** Either (a) remove the two models from `schema.prisma` until SCIM is undeferred, or (b) generate the migration now and never let the code reach it (behind an `ORG_FEATURES.scim_enabled` guard at route level). Option (a) matches the `chore: defer SCIM implementation` commit.

### C7. `SHARED_SECRET` env validator accepts a 1-character secret — VALIDATED
- **Location:** `API/src/config/env.ts:35`
- **Evidence:** `SHARED_SECRET: z.string().min(1)`.
- **Impact:** `SHARED_SECRET` is used for (1) HMAC-signing every config/state/2FA/access JWT, (2) pepper for domain hash, (3) pepper for every token hash (refresh, auth code, email verification). A one-byte secret is trivially brute-forced offline against any captured JWT. The env schema should enforce a floor that matches HMAC-SHA256 key strength (≥32 bytes after UTF-8 encoding).
- **Fix:** `z.string().min(32)` or better, refine to require ≥256 bits of entropy (e.g. require base64 of ≥32 bytes). Document generation via `openssl rand -base64 48`.

---

## HIGH

### H1. Missing security headers: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, CSP — VALIDATED
- **Location:** `API/src/app.ts:9-43` — Fastify is instantiated with only `disableRequestLogging` and a `logger` redact list.
- **Impact:** Auth UIs served alongside this API and email-delivered magic-link landing pages can be framed, MIME-sniffed, or leak Referer headers with tokens. Browsers won't enforce TLS-only (HSTS) for this origin.
- **Fix:** Register `@fastify/helmet` with at minimum HSTS (`max-age=31536000; includeSubDomains; preload`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`. Emit a CSP on any HTML-returning route (`auth-debug-page`, `auth-ui`, email previews).

### H2. No CORS configuration — VALIDATED
- **Location:** `API/src/app.ts` (no `@fastify/cors` registration); grep for `cors` in `API/src` returns zero hits.
- **Impact:** If any browser frontend other than the bundled `/Auth` window calls this API directly (e.g. a dashboard widget), CORS is undefined and either the request fails, or it's silently allowed because no headers are set — depending on the deployment proxy. More importantly, without an explicit allowlist, operators cannot lock it down.
- **Fix:** Register `@fastify/cors` with an origin allowlist derived from the verified `config.redirect_urls` or an env-configured list. Default deny. If the API is strictly backend-to-backend, document that and deny all `Origin`.

### H3. No `bodyLimit` configured — VALIDATED
- **Location:** `API/src/app.ts:12` — Fastify default is 1 MiB.
- **Impact:** 1 MiB per request on every endpoint is ~100× what any auth payload needs. Combined with no per-IP rate limit on unauthenticated endpoints, this amplifies resource exhaustion.
- **Fix:** Set `bodyLimit: 10 * 1024` globally; override per route where needed (none currently need more).

### H4. Fastify `trustProxy` not set — VALIDATED
- **Location:** `API/src/app.ts:12`; `request.ip` is used at `API/src/routes/auth/login.ts:99` and in `login-log.service.ts`.
- **Impact:** On Cloud Run (brief deploys there), `request.ip` will be the internal load-balancer IP, not the real client. Login logs and any future per-IP rate-limiting will be wrong/uniform. Attackers can't spoof XFF today because the field isn't read, but they also can't be distinguished from each other.
- **Fix:** `fastify({ trustProxy: true })` (Cloud Run sets `X-Forwarded-For` from its LB) OR `trustProxy: 1` to trust exactly one hop. Verify against deploy.md.

### H5. Config JWT verification tolerates 3 HMAC algorithms; no algorithm pinning — VALIDATED
- **Location:** `API/src/services/config.service.ts:8, 381`
- **Evidence:** `CONFIG_JWT_ALLOWED_ALGS = ['HS256','HS384','HS512']`.
- **Impact:** Minor but real: multiple acceptable algorithms is a known downgrade-attack shape (e.g. alg confusion between HS* and KS*). The `jose` library already blocks `none`, so this isn't critical, but there's no benefit to accepting three.
- **Fix:** Pin to one (`['HS256']`), document in `llm.ts` schema, reject the others.

### H6. Config JWT verification has no `clockTolerance` — VALIDATED
- **Location:** `API/src/services/config.service.ts:380-383`
- **Impact:** If clients set `exp`, any clock skew between client backend and auth service rejects the config. The spec allows `exp` but our setup gives operators no safety margin.
- **Fix:** `{ algorithms: ['HS256'], audience: expectedAudience, clockTolerance: 30 }`.

### H7. Access token `iss` validated against env var, no `kid` support for key rotation — VALIDATED
- **Location:** `API/src/services/access-token.service.ts` (`verifyAccessToken`), `API/src/services/token.service.ts:192-232` (`signAccessToken`)
- **Impact:** No key rotation path. Rotating `SHARED_SECRET` invalidates every outstanding access token, refresh token hash, auth-code hash, and config JWT simultaneously. That's a hard outage during rotation. No `kid` header → can't run overlap window.
- **Fix:** Introduce `kid` header, maintain an array of active keys with `activeKid` for signing and all listed for verification. Separate `ACCESS_TOKEN_SIGNING_SECRET` from the domain-hash pepper and token-hash pepper so each can rotate independently.

### H8. 2FA challenge token is bound to domain via string comparison, not JWT claim — VALIDATED
- **Location:** `API/src/routes/twofactor/verify.ts:54-56` (domain comparison at app layer)
- **Impact:** If the challenge token lacks an `iss` or `domain` claim and the app-layer check is ever bypassed or refactored, cross-domain 2FA replay becomes possible. Defence-in-depth: bind domain at signing time.
- **Fix:** Add `iss: ${domain}/2fa` or `domain` claim to the challenge JWT; validate via `jwtVerify({ issuer })` rather than reading payload then comparing.

### H9. `TeamInvite.invitedByUserId` is a bare string, not an FK — VALIDATED
- **Location:** `API/prisma/schema.prisma:295`
- **Impact:** Referential integrity hole. If the inviter's user record is deleted, invites retain a dangling string and auditability is lost. Also, the invitedByEmail/Name columns (296-297) duplicate data that should flow from the FK.
- **Fix:** Add a `@relation` with `onDelete: SetNull` (preserves invite history) and name it explicitly so it doesn't clash with the `AcceptedTeamInvites` relation on the same table.

### H10. AccessRequest uses `SetNull` on both user FKs — VALIDATED
- **Location:** `API/prisma/schema.prisma:391-392`
- **Impact:** Workflow audit trail is mutable by user deletion. An attacker who can delete a reviewer's account (e.g. SCIM deprovision in future) erases attribution of every approval they made.
- **Fix:** Change both `onDelete: SetNull` → `onDelete: Restrict`. If a reviewer must be removable, soft-delete the user (`deletedAt` column on `users`) and keep the FK intact.

### H11. LoginLog cascade-deletes with user — VALIDATED, spec-alignment required
- **Location:** `API/prisma/schema.prisma:160`
- **Impact:** `brief.md` 22.8 prescribes finite log retention (hence `pruneLoginLogs`) but does not explicitly require login logs to survive user deletion. For GDPR compliance this is actually correct — deleting the user must remove PII in the log. However, audit trails that reference *other* users' actions against this user would be lost.
- **Fix:** Accept the current `Cascade` but document it in `brief.md` as the intentional GDPR behavior. Consider a separate `anonymized_login_events` table for aggregate metrics that survive user deletion (no email, no IP).

### H12. `Organisation.slug` is globally unique — VALIDATED
- **Location:** `API/prisma/schema.prisma:171`
- **Evidence:** `slug String @unique @db.VarChar(120)` with no composite scope.
- **Impact:** `brief.md` 24 describes per-domain tenancy. Two unrelated customers can collide on slug `engineering`.
- **Fix:** Decide: (a) slugs are per-domain — add `domain` column on Organisation and `@@unique([domain, slug])`; (b) slugs are globally unique across the auth service — keep current but document. Current code is ambiguous and the memory notes this was "flagged in review".

### H13. No cleanup job for `AuthorizationCode`, `VerificationToken`, `RefreshToken` — VALIDATED
- **Location:** `API/src/app.ts:53-73` only prunes `LoginLog`. Search for `delete.*authorizationCode` / `prune` returns only the login-log pruner.
- **Impact:** Unbounded table growth. Expired rows remain forever. `@@index([expiresAt])` exists on all three (lines 120, 98, 145) but nothing consumes it.
- **Fix:** Add `pruneExpiredTokens()` function that runs in the same periodic interval as `pruneLoginLogs()`, deleting rows with `expiresAt < now() - grace`.

---

## MEDIUM

### M1. Refresh-token revocation endpoint has no user-context binding — VALIDATED (partial risk)
- **Location:** `API/src/routes/auth/revoke.ts:17-42` and `API/src/services/refresh-token.service.ts:231-257`
- **Evidence:** `revokeRefreshTokenFamily` silently returns on miss and validates `domain + clientId + configUrl` match, but not that the caller knows the user's access token.
- **Impact:** RFC 7009 allows "knowledge of the token = right to revoke", so this is standards-compliant. However, combined with missing rate limit (C1), an attacker with the domain hash can probe refresh tokens (silent-return doesn't distinguish, which is good) and, if they happen to have a stolen one, can revoke it to force the victim to reauth. Lower severity.
- **Fix:** Add rate limit keyed on domain hash + IP. Optionally also require the access token of the owning user to revoke their own token (more conservative than RFC 7009).

### M2. `User.email` has no case-insensitive collation (`citext`), relies on app-layer normalization — VALIDATED
- **Location:** `API/prisma/schema.prisma:36`, `API/src/services/user-scope.service.ts:5-7`
- **Impact:** App code always lowercases (user-scope, login, register, social all pipe through `buildUserIdentity`), so no duplicate-user bug exists today. Future code path (SCIM provisioning, admin-panel bulk import) that forgets to normalize can insert `User@Example.com` as a fresh row under a different `userKey`.
- **Fix:** Change `email` column to `@db.Citext` (Postgres extension) or add a `lowerEmail String @unique` computed field. Cheaper: add a CHECK constraint `email = lower(email)` via a raw migration.

### M3. `DomainRole.domain` is a plain string, not FK — VALIDATED
- **Location:** `API/prisma/schema.prisma:67`
- **Impact:** No `Domain` model exists. `DomainRole` rows can reference domains that were never validated or that were "retired" at the config level. Not exploitable, but makes data hygiene hard.
- **Fix:** Either introduce a `Domain` table (then FK everything that has a `domain` column — LoginLog, AuthorizationCode, RefreshToken, OrgEmailDomainRule, User, VerificationToken) or add an app-layer regex/length check at write time and document that domain is an app-managed string.

### M4. `TeamMember.customRole` is a free-form string, not FK to `TeamCustomRole` — VALIDATED
- **Location:** `API/prisma/schema.prisma:275`
- **Impact:** Stale references possible; renaming or deleting a `TeamCustomRole` orphans existing member rows.
- **Fix:** Change to `customRoleId String?` with FK to `TeamCustomRole.id`, or enforce via trigger. Document in architecture doc.

### M5. `OrgEmailDomainRule.teamId` uses `SetNull` — VALIDATED
- **Location:** `API/prisma/schema.prisma:202`
- **Impact:** Deleting a team silently re-routes the rule to "org default team" (per line 196 comment). An admin deleting a team doesn't see the rule change.
- **Fix:** `onDelete: Restrict`. Force admins to delete/edit the rule first.

### M6. `VerificationToken.teamInviteId` uses `SetNull` — VALIDATED
- **Location:** `API/prisma/schema.prisma:94`
- **Impact:** Audit trail: tokens that were bound to a specific invite lose provenance. Medium risk — tokens are ephemeral.
- **Fix:** `onDelete: Cascade` if you want the token to die with the invite, or `Restrict` if invites are immutable.

### M7. Logo URL in config has no origin restriction — VALIDATED
- **Location:** `API/src/services/config.service.ts:82` (`logo.url: HttpUrlOrEmptySchema`)
- **Impact:** The auth window renders a logo from any HTTP(S) URL. An attacker who can publish a config (already requires `SHARED_SECRET`) can set a malicious CDN URL that tracks users or loads tracking pixels. Low severity but a cheap CSP-like restriction helps.
- **Fix:** Either restrict to HTTPS + same-origin-as-domain, or rely on the CSP `img-src` (see H1). Safer: accept only base64 data-URLs for logos.

### M8. No indexes on several FK columns that are filtered — VALIDATED
- **Location:** `schema.prisma` — `VerificationToken.userId` (line 91, FK but not indexed), `OrgEmailDomainRule.teamId` (line 202, only in composite unique), `AccessRequest.reviewedByUserId` (line 387, no index).
- **Impact:** Full table scans for queries like "all tokens issued for user X", "all rules routing to team T", "all requests reviewed by user Y".
- **Fix:** Add `@@index([userId])`, `@@index([teamId])`, `@@index([reviewedByUserId])`.

### M9. `randomBytes(32).toString('base64url')` for auth codes — VALIDATED (acceptable but worth noting)
- **Location:** `API/src/services/token.service.ts:34-37`
- **Impact:** 256 bits of entropy, fine. Stored as `sha256(code + '.' + SHARED_SECRET)`. If `SHARED_SECRET` leaks, hashes are recomputable but you also lose the JWT HMAC keys, so compromise is simultaneous.
- **Fix:** Upgrade hashing to HMAC-SHA256 for semantic cleanliness: `hmac(sharedSecret, code)`. Not urgent.

### M10. 2FA TOTP has no replay window (used-code tracking) — VALIDATED
- **Location:** `API/src/services/totp.service.ts:201-241`
- **Impact:** Within the ±1 step window (default), the same 6-digit code is valid for up to 90s and can be replayed. An attacker who captures a code (phishing, MITM on non-HTTPS deployment) has ~45s of reuse.
- **Fix:** Store the last-accepted counter per user; reject codes with counter ≤ last-accepted. Cheap change, material defence.

### M11. `AccessRequest.requestedAt` vs `lastRequestedAt` — semantics undocumented — VALIDATED
- **Location:** `API/prisma/schema.prisma:379-380`
- **Impact:** No field comment, no architecture doc entry. Easy for a future dev to get the semantics wrong (e.g. update `requestedAt` on re-request).
- **Fix:** Add inline comments and architecture doc section.

### M12. `console.error` / `console.warn` used instead of the Fastify logger — VALIDATED
- **Location:** `API/src/services/auth-verify-email.service.ts:268`, `API/src/services/social/social-login.service.ts:130`, `API/src/config/env.ts:96` (SES warning).
- **Impact:** Bypasses redaction, floods stdout on Cloud Run where every byte is billed, makes structured logging inconsistent.
- **Fix:** Thread `app.log` through these services or accept a logger in `deps`. Redaction in `app.ts:21-41` doesn't apply to `console.*`.

### M13. `Domain`-style homograph and IDN normalization not enforced — VALIDATED (minor)
- **Location:** `API/src/utils/hash.ts` and `user-scope.service.ts:9-11` — only `trim().toLowerCase().replace(/\.$/, '')`.
- **Impact:** `examplе.com` (Cyrillic `е`) and `example.com` are different domains. Not actively exploitable against the auth layer because domain is signed into the config JWT which requires the operator to choose it, but any upstream trust of visual-match is unsafe.
- **Fix:** `domain.normalize('NFKC')` and/or reject non-ASCII domains unless explicitly punycoded. Low priority.

---

## LOW

### L1. Rate limiter is per-process `Map` — VALIDATED
`API/src/middleware/rate-limiter.ts:19`. Each Cloud Run instance enforces its own window. A horizontal scale-out of 10 = 10× the effective limit. Fix: Redis backing or `@fastify/rate-limit` with a shared store.

### L2. Rate limit key falls back to `'anonymous'` — VALIDATED
`rate-limiter.ts:56-66`. All unauthenticated callers on a domain share one bucket. Combined with missing rate limit on auth routes this is moot for now, but if C1 is fixed naively with this key builder, the whole internet shares one counter per domain.

### L3. `Config.debug_enabled` flag declared but unused — VALIDATED
`config.service.ts:173` defines it; grep shows no reader. Dead flag is a footgun — future code may wire it to expose config internals.

### L4. Authorization code hash concatenation uses `.` separator — VALIDATED (cosmetic)
`token.service.ts:39`. Fine, but prefer HMAC (see M9).

### L5. Social state JWT includes `iss` at signing but doesn't enforce on verify — VALIDATED
`social-state.service.ts:50,71`. `setIssuer(...)` is called but `jwtVerify` is invoked without an `issuer` option. Add `issuer: ${baseUrl}/social-state` to verify.

### L6. `AiTranslation.data` is `Json` with no documented shape — VALIDATED
Add a shape comment; ideally an import-time validator before writes.

### L7. `Organisation`, `OrgMember`, `TeamMember`, `GroupMember` have no soft-delete — VALIDATED
History churn visible only via LoginLog-like tables that don't exist for membership. Decision needed; if GDPR dictates hard delete, document it.

### L8. `parentTokenId` / `replacedByTokenId` unique but cycle not prevented at DB level — VALIDATED
`schema.prisma:129-130`. App code prevents cycles today; add a comment so future changes don't lose the invariant.

### L9. SMTP provider has no `tls.rejectUnauthorized` env — VALIDATED
`email.service.ts`. Production should reject self-signed; test/staging may need otherwise. Add `SMTP_TLS_REJECT_UNAUTHORIZED`.

### L10. `VerificationToken.type` not indexed — VALIDATED
Small tables today, but `@@index([type, expiresAt])` helps the future prune and "find password-reset tokens for user" queries.

### L11. `extractEmailDomain` duplicated across `auth-register.service.ts:82-86` and `social/social-login.service.ts:28-32` — VALIDATED
Move to `utils/email.ts`.

### L12. `TeamMember` / `GroupMember` FKs have no `onUpdate: Cascade` — UNVERIFIED (defensive)
CUIDs are immutable in practice; skip unless you plan ID normalization.

---

## Info / Positives (worth naming so they don't regress)

- **I1.** Password hashing uses argon2id (`password.service.ts:20-27`) with memoryCost 32 MiB + timeCost 3 + timing-safe verify via dummy hash. Solid.
- **I2.** Refresh token family rotation with `familyId` + `parentTokenId` + `replacedByTokenId` unique constraints implements RFC-style reuse detection (`refresh-token.service.ts`, `schema.prisma:125-148`).
- **I3.** `LoginLog` is append-only (no `updatedAt`) — correct audit-log shape.
- **I4.** All auth errors are funnelled through `AppError` + global error handler, returning generic `{ error: "Request failed" }` per brief §20.
- **I5.** `disableRequestLogging: true` + redact list in `app.ts` is the right posture for a secrets-heavy service.
- **I6.** Config JWT domain is verified against `config_url` hostname (`config.service.ts:398`), preventing "mint a config for someone else's domain on your own CDN".
- **I7.** `assertProviderVerifiedEmail` (`provider.base.ts:30`) is called in every social login path — the pattern is right; C5 is the one provider that violates it.
- **I8.** GitHub social login explicitly fetches the user's email list and selects a verified one (`github.service.ts:160-167`). Good pattern — replicate for Facebook.
- **I9.** Authorization code is one-time via `updateMany { where usedAt: null } then set usedAt = now` (`token.service.ts:175-186`) — atomic and race-safe.
- **I10.** Env parsing via Zod at boot (`config/env.ts`) with `ACCESS_TOKEN_TTL` bounds (15–60 min). Sensible constraints.

---

## Hallucinations removed during validation

The following claims from the exploration pass did NOT survive code review and are excluded above:

1. **"Login route does not pass email to `recordLoginLog`."** False — `login.ts:96` explicitly passes `email`.
2. **"Password reset has a timing side-channel via `findUnique`."** Dubious — the route returns generic `{ ok: true }` regardless of hit/miss, and response time is dominated by the email send (hit) vs. nothing (miss). The miss path returns faster than the hit path, which IS a real but low-severity signal; the agent's characterization (timing-safe crypto required) was overstated. Moved to UNVERIFIED list below.
3. **"User.email case-sensitive duplicates possible."** Misleading — uniqueness is enforced via `userKey`, which is derived from `lowerCase(trim(email))` in every write path (`user-scope.service.ts`). Kept as M2 (medium, defence-in-depth).
4. **"Revoke endpoint allows revoking other users' tokens."** False — knowledge of the raw refresh token is required; this is RFC 7009 behavior. Kept as M1 with correct framing.

## UNVERIFIED / deferred to verifier pass

- Possible timing signal on password-reset between user-exists (hit email service) vs not-exists (return early). Needs a measurement test, not static review.
- Whether Fastify 5's default body parser handles malformed JSON with constant-time behavior.
- Whether `tryParseHttpUrl` rejects `javascript:` URIs in all execution paths.
- Whether `auth-debug-page` (`routes/root/config-docs.ts`?) exposes any sensitive internals under `debug_enabled`.

---

## Verifier-Pass Addendum (2026-04-20)

Second pass using four parallel verifiers (codex, Claude code-reviewer subagent, gemini-cli, and a swarm of 10 `max` agents with differentiated focus areas). Each finding below was re-validated against source before being added. Gemini completed with only retry errors and produced no usable findings. One `max` agent (#8) reported the repo inaccessible. Findings from the remaining nine plus codex are merged.

### New CRITICAL findings (validated)

- **VC1 — `POST /config/verify` is an unauthenticated debug oracle.** `API/src/routes/root/config-verify.ts` registers the route with no `preHandler`, no auth, no rate limit. Handler runs `verifyClientConfig` which returns a structured breakdown of: config JWT signature validity, audience match, domain↔config_url match, schema validity. An unauthenticated attacker can brute-force the shared secret offline by submitting forged JWTs until `jwtValid: true` comes back, probe whether a domain is registered, and enumerate the config shape. Severity: **Critical**. Fix: require domain-hash auth OR restrict to non-production builds, and rate-limit heavily.
- **VC2 — Organisation schema / migration / client drift.** `API/prisma/schema.prisma:168-189` defines `Organisation` without a `domain` column and with a global `@unique` on `slug`. Migration `20260215143000_add_org_team_group_tables/migration.sql:79,85` still creates `organisations_domain_idx` and `organisations_domain_slug_key` on `(domain, slug)` with no later migration to drop them. The generated Prisma client at `node_modules/.prisma/client/schema.prisma:157-177` still has the old `domain` column, which is why the codebase compiles — but `API/src/services/organisation.service.ts:107,127,...` still writes `where: { domain }`. Any `prisma generate` will strip `domain` from the client types and break the build. Worse, if a fresh database is created from the current schema, no `domain` column exists, and `organisation.service.ts` queries will fail at runtime. Severity: **Critical** (production deploy on a fresh DB breaks org features entirely). Fix: decide whether orgs are domain-scoped; if yes, restore the `domain` column + composite unique + index in schema; if no, remove all `normalizeDomain(input.domain)` queries in `organisation.service.ts` and write a migration to drop the legacy constraints.

### New HIGH findings (validated)

- **VH1 — `/auth/callback/:provider` has no `preHandler` chain.** `API/src/routes/auth/callback.ts:56` registers the route with only `async (request, reply) => ...`. No `configVerifier`, no rate limiter. The handler does fetch+verify the config internally (line 88-94), so config trust is preserved, but each unauthenticated GET triggers: state JWT verify, HTTPS fetch to config URL, config JWT verify, and a provider OAuth code-exchange (up to 5 upstream API calls). A flood of calls amplifies DoS against both this service and the upstream OAuth provider (which can lead to IP bans for legitimate users). Severity: **High**. Fix: apply a per-IP rate limiter before the handler.
- **VH2 — `createUserDomainRateLimitKey` trusts unvalidated `X-UOA-Access-Token` header.** `API/src/middleware/rate-limiter.ts:55-67` builds the bucket key as `${prefix}:${domain}:${token ?? 'anonymous'}` by reading the header directly. Any attacker who knows the target's domain-hash (needed to pass domain-auth) can bypass per-user throttling by rotating the header value — each unique token string creates a new bucket. This also means L2 (anonymous shared bucket) isn't the only failure mode: if this key builder were ever wired onto an unauthenticated endpoint, the attacker could mint arbitrary headers to escape the limit entirely. Severity: **High** latent (no current caller is exploited, but the helper is unsafe-by-default). Fix: derive the user portion of the key from an authenticated identity (userId from verified access token), not from a raw client header.
- **VH3 — Access-token verification pins `issuer` but not `audience`.** `API/src/services/access-token.service.ts:62-65` calls `jwtVerify(token, ..., { algorithms, issuer })`. No `audience` is passed. Because the same `SHARED_SECRET` is used to sign config JWTs, social state JWTs, 2FA challenge JWTs, access tokens, and refresh tokens, cross-type token confusion is only prevented by (a) differing issuer claims and (b) schema-layer claim validation. A config JWT signed by a compromised client backend with `iss: AUTH_SERVICE_IDENTIFIER` (which is the shared identifier also used as access-token issuer) and the right shape could pass access-token verification. Severity: **High**. Fix: set and require a distinct audience per token type (e.g. `aud: 'access-token'`), and/or separate signing keys per token class.
- **VH4 — `SHARED_SECRET` is used for every JWT type.** Config JWT, access token, refresh token, social state JWT, and 2FA challenge JWT are all signed with the same `SHARED_SECRET` (`env.ts:35`, cross-referenced in `config.service.ts`, `token.service.ts`, `access-token.service.ts`, `social-state.service.ts`, `twofactor-challenge.service.ts`). Any leak or brute-force of the secret (see VC1, VC7) compromises all token types simultaneously, and clients who legitimately hold the secret (to sign their own config JWTs) can also forge access tokens for any user in their domain. Severity: **High**. Fix: derive separate subkeys per token class via HKDF, or introduce a dedicated internal signing key for server-issued tokens (access/refresh/state/challenge) that is never shared with client backends.
- **VH5 — Team role allowlist contradicts schema and spec.** `API/src/services/team.service.base.ts:42` declares `ALLOWED_TEAM_ROLES = new Set(['member', 'lead'])`. `normalizeTeamRole` (line 162) throws 400 on anything else. Meanwhile `API/prisma/schema.prisma:274` comments that `teamRole` is `"owner" | "admin" | "member"`, and `isTeamManager` at line 167 checks for `'owner' || 'admin'`. The brief at §754 notes the `lead` role was superseded by `admin`. Net result: no role that `normalizeTeamRole` accepts can ever pass `isTeamManager`, so the privilege-elevation path through team role is dead. This is a functional break but also a security concern because the code silently enforces a weaker role set than the schema allows — a caller reading only the schema will assume `admin` is supported. Severity: **High**. Fix: align `ALLOWED_TEAM_ROLES` with the schema's documented enum.
- **VH6 — `POST /auth/email/team-invite-open/:inviteId.gif` tracking pixel exposes open events.** `API/src/routes/auth/email-team-invite-open.ts:13` has no auth, no rate limit. It calls `trackTeamInviteOpen` and returns a 1×1 GIF. Because invite IDs are CUIDs (not sequential but also not cryptographically unlinkable from the invite URL), anyone who intercepts or shoulder-surfs an invite email can probe this endpoint to determine whether/when the invitee opened it, and they can replay the pixel URL to fake "opened" events. This is a privacy leak (GDPR-relevant) and an integrity issue against audit logs. Severity: **High**. Fix: sign the pixel URL with HMAC(inviteId + timestamp) and verify the MAC before recording; or require session + rate limiting.
- **VH7 — Config-URL SSRF through `fetchConfigJwtFromUrl`.** `API/src/services/config.service.ts:323-366` only blocks non-http/https protocols before issuing the fetch. No guard against RFC-1918, link-local, loopback, or cloud metadata IPs. An attacker controlling a registered domain can submit `config_url=http://169.254.169.254/latest/meta-data/...` or `http://127.0.0.1:...` to make the auth service fetch internal endpoints and then surface the raw body in error messages (if `debug_enabled`) or gate responses on whether the fetched body parsed as a JWT. Severity: **High**. Fix: resolve the hostname to IPs before fetching and reject non-public IPs, disallow HTTP in production, enforce a short timeout, and strip redirects that cross into private IP space.
- **VH8 — Password-reset and verify-email tokens are not invalidated when a new one is issued.** `API/src/services/auth-reset-password.service.ts:79-131` and `auth-register.service.ts` both create a new `VerificationToken` row without marking prior unconsumed tokens for the same `(userId, configUrl)` as used. An attacker with persistent inbox access can collect all issued tokens and keep the oldest live one (up to 30 min). Severity: **High**. Fix: before `verificationToken.create`, run `updateMany({ where: { userId, configUrl, usedAt: null, type }, data: { usedAt: new Date() } })`.
- **VH9 — `SHARED_SECRET` leakage via timing side-channel in `config-verifier.ts`.** `API/src/middleware/config-verifier.ts:46-49` does `config_url.includes(SHARED_SECRET)` and `.includes(encodeURIComponent(SHARED_SECRET))`. Both are variable-time substring searches. An attacker with a self-hosted config endpoint cannot use this directly (they don't supply the server's secret) — but because `config_url` is attacker-controlled and the compare is done on every request, timing differences between "first byte matches" vs "no match" could theoretically leak prefix matches under heavy measurement. Exploitability is weak because network jitter dominates, but the defensive guard is non-constant-time. Severity: **High** if exploitable; **Medium** in practice. Fix: drop the check (reliance on JWT signature is sufficient) or compare via `timingSafeEqual` on a fixed-length keyed hash.

### New MEDIUM findings (validated)

- **VM1 — `/auth/domain-mapping` rate-limit key uses `request.ip` without `trustProxy`.** `API/src/routes/auth/domain-mapping.ts:18-19` + `API/src/app.ts` (no trustProxy). On Cloud Run, `request.ip` is the load balancer IP — all traffic shares one bucket, effectively disabling the 60/min limit. Fix: set `trustProxy: 1` (and cap the key by domain+XFF or a signed token to prevent trivial spoofing).
- **VM2 — `GET /org/organisations` lacks `requireOrgRole()`.** `API/src/routes/org/organisations.ts:149-164` chains `[parseDomainContextHook, configVerifier, requireDomainHashAuthForDomainQuery(), requireOrgFeatures]` — no role check. `POST /org/organisations` (line 175-179) includes `requireOrgRole()` correctly. The service-layer `getOrganisation` at `organisation.service.ts:125-128` queries by `{ id, domain }` with no membership check. Any valid domain-hash bearer can enumerate orgs by ID on that domain. Fix: add `requireOrgRole()` OR a membership assertion in the service.
- **VM3 — `acceptTeamInviteWithinTransaction` does not assert `user.email === invite.email`.** `API/src/services/team-invite.service.acceptance.ts` consumes the invite without verifying the authenticated user's email matches the invite's email. Current callers always pre-match, but a future caller that forgets to would let an authenticated user on the same domain accept any invite whose token they obtain. Severity: **Medium** latent. Fix: add the assertion inside the transaction function itself.
- **VM4 — `consumeAuthorizationCode` ignores `redirect_url`.** `API/src/services/token.service.ts:144-190` validates domain and configUrl but not `redirectUrl`. The column `AuthorizationCode.redirectUrl` is written at line 125 and never read. Combined with C3 (which already flags this), token-exchange endpoint has no `redirect_url` parameter at all (`API/src/routes/auth/token-exchange.ts`), so there is nothing for `consumeAuthorizationCode` to check against. This is a defense-in-depth gap for stolen-code replay across allowlisted redirect URLs. Fix: require `redirect_url` in token-exchange body per RFC 6749 §4.1.3, and enforce `row.redirectUrl === params.redirectUrl`.
- **VM5 — `OrgEmailDomainRule` nullable `teamId` defeats the unique constraint.** `API/prisma/schema.prisma:204` declares `@@unique([orgId, emailDomain, teamId])`. Postgres treats `NULL` as distinct in unique constraints, so an org can accumulate multiple default-team rules for the same `(orgId, emailDomain)`. Fix: use a partial unique index (`WHERE team_id IS NULL`) or a `COALESCE(team_id, '<sentinel>')` expression index.
- **VM6 — Token-bearing responses and email-token HTML landing pages lack `Cache-Control: no-store`.** `API/src/routes/auth/token-exchange.ts:72` returns access/refresh tokens without cache directives; `/auth/email/reset-password` and `/auth/email/link` render HTML with token context in URL params without `no-store`. Intermediate proxies or browsers may cache the response. Fix: set `Cache-Control: no-store, no-cache, must-revalidate` + `Pragma: no-cache` on all token/email-landing responses.
- **VM7 — CSS value interpolation without sanitization for `font_family`.** `Auth/src/theme/theme-utils.ts:58-63,174` emits the raw `font_family` string into `--uoa-font-family` and `ThemeProvider.tsx:28-41` interpolates the CSS variable map directly into a `<style>` tag. A malicious config could break out of the var declaration with `serif; } body { ... } .x {`, then load external fonts or extract data via `url()`. Other theme values go through `SafeCssValue` checks (color/length validation); `parseFontFamily` only does `.trim()`. Severity: **Medium** (requires malicious config, which is also the trust boundary for the system, but theme is intended to be merchant-level data). Fix: allowlist a character set (`^[a-zA-Z0-9 ,'"-]+$`) or map to preset fonts only.
- **VM8 — `/llm` unauthenticated endpoint documents the domain-hash derivation and env var names.** `API/src/routes/root/llm.ts:18-19,27-32` returns `SHA-256(domain + SHARED_SECRET)` plus the `SHARED_SECRET` env var name. All of this is public in the source, but pinning it at a well-known path aids automated attack tooling and correlation with source-code derivation bugs (e.g. C2). Severity: **Medium**. Fix: gate `/llm` behind domain-hash auth, or trim it to a generic integration guide without cryptographic primitives.
- **VM9 — Org-role middleware trusts JWT claims without DB re-check.** `API/src/middleware/org-role-guard.ts:67-86` reads `claims.org.org_id` and `claims.org.org_role` from the access token and allows the request. A user removed from the org retains org-scoped access for the remainder of the token TTL (15-60 min). Service layers that call `getOrganisationMember` do re-check, but middleware-only gated routes do not. Severity: **Medium** (access revocation latency = token TTL). Fix: either document the latency as intentional or add a DB lookup in middleware for destructive ops.

### New LOW / INFO findings (validated)

- **VL1 — Duplicate endpoints `POST /org/organisations/:orgId/transfer-ownership` and `POST /org/organisations/:orgId/ownership-transfer`** both route to `transferOwnershipHandler` at `API/src/routes/org/organisations.ts:414-436`. Brief 24.3 specifies only one. Drop one; update `GET /` and `GET /llm` schema exports.
- **VL2 — `RefreshToken.clientId` has no index** (`API/prisma/schema.prisma:125-147`). Revocation by OAuth client scans the full table. Add `@@index([clientId])`.
- **VL3 — `ScimToken.tokenHash` uses bare SHA-256 where other token hashes use HMAC/peppered SHA-256** (`schema.prisma:323` vs `verification-token.ts:12-16`). Latent until SCIM code lands; fix now to avoid inconsistency.
- **VL4 — `TeamInvite` allows duplicate pending invites per `(teamId, email)`** — no unique at DB level, only app-layer dedup.
- **VL5 — `AccessRequest` allows duplicate pending requests** — no unique at DB level with `status = PENDING`.
- **VL6 — "Account exists" registration email subject leaks existence** (`API/src/services/email.templates.ts:354`). The body says "Someone tried to create an account with this email, but you already have one." A shared device lock-screen preview of the subject would reveal account existence to any observer of the inbox. Fix: use a neutral subject like "Finish setting up your account" and keep the branching entirely server-side.
- **VL7 — `/auth/email/reset-password`, `/auth/email/twofa-reset`, `/auth/email/team-invite`, `/auth/email/team-invite/decline`, and `POST /auth/verify-email` have no rate limit.** Tokens are high-entropy so enumeration is infeasible, but there is no per-token or per-IP throttle on token-consumption attempts, DB hits, or subsequent HTML renders.
- **VL8 — `social-state.service.ts` sets `iss` at signing but does not enforce `issuer` on `jwtVerify`** (line 52 vs 69). Already noted as L5 in the main report — adding here to confirm codex and two max agents independently flagged it.
- **VL9 — `register.ts:31` reads `request.query.request_access` via unchecked type cast** instead of the route's parsed Zod schema. `parseRequestAccessFlag` handles any input safely, but this bypasses the query-validation layer.
- **VL10 — Query schemas broadly use `.passthrough()` instead of `.strict()`** (20+ route files). No route reads `request.query` directly today, so passive only. Worth converting for defense-in-depth.

### Verifier claims reviewed but REJECTED

- **"Apple `email_verified` often absent; parseBooleanish returns false for undefined"** (max-4). Current behavior — treat absent `email_verified` as unverified and reject — is the correct fail-closed policy per brief 22.6. No change needed; the claim misreads fail-closed as a bug.
- **"Google can unilaterally revoke `email_verified` after security events"** (max-4). True upstream behavior, not an implementation issue. Out of scope.
- **"Apple `APPLE_KEY_ID` rotation has no fallback"** (max-4). Operational documentation, not security. Deferred.
- **"`domain-mapping.ts` dead null-check on `request.config`"** (max-7). True but not a vulnerability; code cleanliness.
- **"TOTP inner `!==` length check before `timingSafeEqual`"** (max-9). Unreachable — `assertTotpCodeValid` enforces length upstream. Not exploitable.
- **"Access token verification cross-confusion via missing aud"** framed as Critical (max-2). Downgraded to High (VH3) — requires secret-holder collusion; issuer pinning provides partial separation.
- **"Registration email `You already have an account` is a Critical enumeration bug"** (codex, framed as High). Downgraded to Low (VL6) — email is sent only to the real mailbox owner, so the enumeration vector requires inbox observation; subject-line preview is the realistic leak.
- **"Config URL secret guard is brute-forceable via timing"** (max-9, framed as High). Retained as VH9 but exploitability is weak; network jitter dominates the timing signal.

### Verifier cross-confirmations (already in main report)

Multiple verifiers independently CONFIRMED these original findings against source: C1 (rate-limit coverage gap), C2 (domain-hash non-constant-time compare), C3 (auth code not bound to redirect), C4 (no PKCE), C5 (Facebook hardcoded `emailVerified`), C6 (SCIM models without migration), C7 (`SHARED_SECRET` 1-char minimum), H1 (no security headers), H4 (`trustProxy` off but `request.ip` used for logs), H5 (config JWT accepts 3 algorithms), H6 (no clockTolerance), H7 (no kid), H10 (SetNull on AccessRequest user FKs), H11 (LoginLog cascade delete), H13 (unpruned tokens), M6 (teamInviteId SetNull), M8 (missing indexes), M9 (sha256 token hash without HMAC), M10 (TOTP no last-counter), M12 (console.error bypass of redaction), L1 (in-memory rate-limit store), L2 (anonymous rate-limit key). These are not re-listed above; see the original sections.

### Verifier corrections to main report

- **H8 reframe** — 2FA challenge JWT DOES include `domain` in the signed payload (`twofactor-challenge.service.ts:60`). The original framing was wrong. The real issue: no `issuer` is set or enforced on the 2FA challenge JWT, so cross-service confusion with other shared-secret JWTs of the same audience is possible. Update H8 in the Status register accordingly.
- **H12 reframe** — Globally unique `Organisation.slug` is not the security issue; the issue is schema/migration/code drift (VC2 above). Update H12 to reference VC2.
- **C1 scope** — The rate-limiter IS wired on `POST /org/organisations` (`organisations.ts:175-179`) and `POST /org/organisations/:orgId/members` (line 315-319), in addition to `domain-mapping.ts`. The "only two routes" claim was too narrow; the auth-route gap remains the core issue.
