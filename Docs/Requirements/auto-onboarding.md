# Auto-Onboarding & Per-Domain JWK Admin

Status: approved, in implementation
Owner: superuser-only feature
Branch: `feature/auto-onboarding`

## 1. Goal

Today onboarding a new SSO partner requires a UOA superuser to:

1. Edit `CONFIG_JWKS_JSON` env var to add the partner's public RSA JWK.
2. Redeploy UOA on Cloud Run.
3. Open `/admin > Configuration > Secrets`, click **Add Domain**, paste the partner's domain + a generated client secret.
4. Manually share the revealed `client_secret` and `client_hash` with the partner over an out-of-band channel.

This is fragile (env-var edits + redeploy) and high-friction. The goal of this feature is:

- Partners self-onboard by following the existing `/llm` integration guide and adding two optional fields to their config JWT payload.
- UOA captures everything it needs in a **single auto-discovery moment** when the partner makes their first `/auth` call.
- A superuser approves or declines from the admin UI.
- On approval, UOA emails a one-time claim link to the partner's `contact_email`. The partner opens the link, sees the `client_secret` + `client_hash` once.
- Per-domain signing keys live in Postgres (no more env-var edits or redeploys).

## 2. Non-goals (v1)

- No self-service for non-superusers.
- No webhook / API callback for partner notification — email-only.
- No automatic JWK rotation. Partners rotate by adding a new `kid` to their JWKS and signing future configs with it. Superuser deactivates old `kid` rows manually if needed.
- No multiple notification recipients per domain — single `contact_email` from the config payload.
- No editing of a submitted integration request — decline-and-resubmit is the workflow.
- No UI for end-user partners themselves — everything partners see is the friendly "pending review" page on `/auth` and the SES email.

## 3. Architecture overview

### 3.1 New config payload fields (optional, additive)

The partner adds these to the config JWT payload they sign and serve at `config_url`:

| Field | Type | Required for | Notes |
|---|---|---|---|
| `jwks_url` | string (HTTPS) | Auto-onboarding only | Hostname **must equal** the `domain` claim. Same SSRF rules as `config_url` fetch. |
| `contact_email` | string | Auto-onboarding only | Used for the one-time claim email and any future operational notifications. |

Existing partners who are already in `client_domains` keep working unchanged. These fields are inert for already-registered domains.

### 3.2 Trust model

Trust comes from the **superuser approving a pending request**, not from auto-discovery. Auto-discovery only verifies that the JWT was signed by the key the partner publishes. A superuser must still accept before any auth flow against that domain succeeds.

### 3.3 Two new persisted concepts

- **`client_domain_jwks`** — public JWKs scoped to a registered domain. Replaces (and supplements during transition) `CONFIG_JWKS_JSON`.
- **`client_domain_integration_requests`** — pending / declined / accepted intake records. The accepted record stays for audit and links to the created `client_domains.id`.

### 3.4 One-time claim tokens

After a superuser accepts a request, UOA creates a single-use 24-hour token, emails the partner a claim URL, and the partner reveals their `client_secret` + `client_hash` once.

## 4. End-to-end flow

### 4.1 Partner setup (per `/llm` Phase 0–4)

1. Generate RSA-2048 keypair, pick a stable `kid`.
2. Stand up a public HTTPS JWKS endpoint on **the same hostname** as their config URL (e.g. `https://api.partner.com/.well-known/jwks.json`).
3. Stand up `config_url` returning a signed RS256 JWT whose payload contains the standard fields plus the new `jwks_url` and `contact_email`.
4. Make one `/auth?config_url=...&redirect_url=...&code_challenge=...&code_challenge_method=S256` call.

### 4.2 UOA auto-discovery on first call

1. Receive `/auth` with unknown `kid` after fetching `config_url`.
2. Decode JWT header + payload **unverified** (jose `decodeProtectedHeader`, `decodeJwt`).
3. Read `jwks_url` and `contact_email` from the payload. If either is missing, fail with the existing `CONFIG_JWT_INVALID` (no auto-discovery for partners that don't opt in).
4. Validate that `URL(jwks_url).hostname === payload.domain` (case-insensitive). If not, refuse — `INTEGRATION_JWKS_HOST_MISMATCH`.
5. Fetch `jwks_url` via the **existing SSRF-protected pipeline** (same 5s timeout, 64KB cap, public-IP-only enforcement, redirect cap of 3). Reuse `config-fetch.service.ts` infrastructure.
6. Parse the JWKS document with the existing JWK validator (`config-jwks.service.ts`): RSA only, required `kty/kid/n/e`, reject any private members.
7. Find the JWT's `kid` in the JWKS. If absent, refuse — `INTEGRATION_KID_NOT_IN_JWKS`.
8. Verify the JWT signature against that JWK using `jose.jwtVerify`.
9. Schema-validate the payload (`ClientConfigSchema`) so we can store a `config_summary`.
10. Insert / upsert a row into `client_domain_integration_requests` with status `pending` (uniqueness rule below).
11. Return a friendly **"Integration pending review"** page — same look as the existing auth error page, but with explicit text: "An UnlikeOtherAuthenticator superuser has been notified. You will receive an email at `contact_email` once your integration is approved." No internal details leaked.

### 4.3 Re-attempt while pending or declined

- If a `pending` row already exists for the same domain with the same JWK fingerprint and `jwks_url` → no DB write, return the same friendly page.
- If a `declined` row exists for the same domain → return a friendly "Integration declined. Contact support." page. **No new pending row created.**
- If a row exists but the JWK fingerprint changed (different `kid` or different `n`) while still `pending` → update the row in place (it's the same partner iterating).

### 4.4 Superuser review in admin

New nav item: **Configuration > New Integrations** (above Domains & Secrets).

Detail panel shows:

- Submitted at, last seen at
- `domain`, `contact_email`
- JWK SHA-256 fingerprint (Base64URL of `SHA-256(canonical JSON of {kty, kid, n, e})`) + raw JWK JSON in a collapsed view
- `jwks_url` and `config_url`
- Schema-validated `config_summary` (parsed payload safe view)
- Pre-validation result (the same `/config/validate` runtime checks, run with the captured JWK)

Buttons:

- **Accept** — promotes the request, generates a client secret, emails the claim link.
- **Decline** — opens a "reason" dialog (free text, required), sets status `declined`. **Does not** email the partner — silent decline.
- **Delete** — only enabled when status is `declined` or `accepted`. Removes the row entirely. After deletion, that domain can submit a fresh request.

### 4.5 Accept transaction

In a single Prisma `$transaction`:

1. Insert `ClientDomain` (status `active`, label = the partner's domain or admin-edited label).
2. Insert `ClientDomainJwk` (active, kid, jwk JSONB).
3. Generate 36-byte base64url client secret server-side. Compute `clientHash = SHA256(domain + clientSecret)`. Compute `secretDigest = HMAC-SHA256(SHARED_SECRET, clientHash)`. Insert `ClientDomainSecret` (active, `secretDigest`, `hashPrefix` = first 16 chars of `clientHash`).
4. Generate 32-byte random claim token. Compute `tokenHash = SHA256(token)`. Insert `IntegrationClaimToken` (`tokenHash`, `expiresAt = now + 24h`, `usedAt = null`, FK to integration request id).
5. Update integration request: status `accepted`, `clientDomainId` set, `reviewedAt`, `reviewedBy`.
6. Write audit log row.
7. **After** transaction commits, send SES email to `contact_email` with the claim URL `https://<host>/integrations/claim/<token>`. (Do not block transaction on email send; failure is logged, superuser can resend.)

The raw `client_secret` lives only in:
- The Accept service's local memory long enough to email the claim link (encoded into the link? No — only the token is in the link; secret is fetched from a transient store keyed by `tokenHash`).

**Storage of the raw secret pending claim:** UOA creates a row in `IntegrationClaimToken` that includes an **encrypted** copy of the raw `client_secret`, encrypted with `SHARED_SECRET` via AES-256-GCM. On claim, the secret is decrypted, returned once, and the row's `usedAt` is set. Once claimed, the encrypted blob is deleted (set to NULL). After 24h expiry, a sweep job deletes the encrypted blob.

This is the **one place** where a secret-equivalent value lives temporarily in DB. It is short-lived, encrypted at rest with the deployment-wide `SHARED_SECRET`, single-use, and bounded by token expiry.

### 4.6 Claim flow

1. Partner receives email: subject "Your UnlikeOtherAuthenticator integration is approved", body explains next steps and includes the claim URL.
2. Partner opens `https://<host>/integrations/claim/<token>` in a browser.
3. Server-side: hash the token, look up the claim row.
   - If not found / expired / used → friendly "This claim link is no longer valid. Contact support." page.
   - If valid → decrypt `client_secret`, render a one-time page showing `client_secret` + `client_hash` + copy buttons + integration instructions (link to `/llm`). Set `usedAt` and clear the encrypted blob in the same transaction.
4. Page warns: "This is the only time this secret will be displayed."

### 4.7 Resend / rotation flows

- **Resend claim email** (admin button on accepted request, only while token is unclaimed): generates a new claim token, deletes the old one, emails again.
- **Rotate** (existing Secrets page button, behavior changes): generates a new secret, creates a new claim token, emails the claim link to the current `contact_email` from the partner's most recent successful config fetch. Old secret is deactivated **only when the partner claims** the new one (so the integration doesn't break before they fetch).

## 5. Data model

### 5.1 `client_domain_jwks`

```prisma
model ClientDomainJwk {
  id              String      @id @default(cuid())
  domainId        String
  domain          ClientDomain @relation(fields: [domainId], references: [id], onDelete: Cascade)
  kid             String      @unique
  jwk             Json
  fingerprint     String      // Base64URL SHA-256 of canonical {kty,kid,n,e}, indexed
  active          Boolean     @default(true)
  createdAt       DateTime    @default(now())
  deactivatedAt   DateTime?
  createdByEmail  String?
  @@index([domainId, active])
  @@map("client_domain_jwks")
}
```

### 5.2 `client_domain_integration_requests`

```prisma
model ClientDomainIntegrationRequest {
  id                  String                          @id @default(cuid())
  domain              String
  status              ClientDomainIntegrationStatus   @default(PENDING)
  contactEmail        String
  publicJwk           Json
  jwkFingerprint      String
  kid                 String
  jwksUrl             String
  configUrl           String?
  configSummary       Json?
  preValidationResult Json?
  declineReason       String?
  reviewedAt          DateTime?
  reviewedByEmail     String?
  clientDomainId      String?
  submittedAt         DateTime  @default(now())
  lastSeenAt          DateTime  @default(now())
  @@unique([domain], map: "client_domain_integration_request_domain_unique_open", name: "uniq_open_domain")
  // partial unique enforced via raw SQL migration: WHERE status IN ('PENDING','DECLINED')
  @@index([status, submittedAt])
  @@map("client_domain_integration_requests")
}

enum ClientDomainIntegrationStatus {
  PENDING
  ACCEPTED
  DECLINED
}
```

The unique constraint is implemented as a **partial unique index** in the migration:
```sql
CREATE UNIQUE INDEX client_domain_integration_request_domain_open_unique
  ON client_domain_integration_requests (domain)
  WHERE status IN ('PENDING', 'DECLINED');
```
This allows historical `ACCEPTED` rows to coexist with future re-onboarding attempts.

### 5.3 `integration_claim_tokens`

```prisma
model IntegrationClaimToken {
  id                String   @id @default(cuid())
  integrationId     String
  integration       ClientDomainIntegrationRequest @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  tokenHash         String   @unique
  encryptedSecret   Bytes?   // AES-256-GCM ciphertext of raw client_secret; null after claim
  encryptionIv      Bytes?
  encryptionTag     Bytes?
  expiresAt         DateTime
  usedAt            DateTime?
  createdAt         DateTime @default(now())
  @@index([integrationId])
  @@map("integration_claim_tokens")
}
```

### 5.4 Audit log

Reuse or add `admin_audit_log` (table to be checked — if not present, add as part of this feature) with rows for:

- `integration.accepted`, `integration.declined`, `integration.deleted`, `integration.claim_resent`
- `jwk.added`, `jwk.deactivated`
- `domain.disabled`, `domain.enabled`, `domain.secret_rotated`

Each row: `actorEmail`, `action`, `targetDomain`, `metadata` JSONB, `createdAt`.

## 6. API surface

### 6.1 Public

| Method | Path | Notes |
|---|---|---|
| `GET` | `/integrations/claim/:token` | Renders the one-time claim page. Public, IP rate-limited. No auth. |
| `POST` | `/integrations/claim/:token/confirm` | Marks the claim as used and returns the JSON `{ client_secret, client_hash, domain, hash_prefix }` (or returns it as a server-rendered HTML page). One-shot. |

### 6.2 Internal admin (superuser only, behind `/internal/admin`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/internal/admin/integration-requests` | List with `status` query filter. |
| `GET` | `/internal/admin/integration-requests/:id` | Detail (request + pre-validation + linked clientDomain if accepted). |
| `POST` | `/internal/admin/integration-requests/:id/accept` | Body: `{ label?: string }`. Runs the accept transaction + sends claim email. |
| `POST` | `/internal/admin/integration-requests/:id/decline` | Body: `{ reason: string }`. |
| `DELETE` | `/internal/admin/integration-requests/:id` | Only when status is `declined` or `accepted`. |
| `POST` | `/internal/admin/integration-requests/:id/resend-claim` | Generates a new claim token, deletes old, re-emails. |
| `GET` | `/internal/admin/domains/:domain/jwks` | List JWKs registered for a domain. |
| `POST` | `/internal/admin/domains/:domain/jwks` | Add a JWK manually. Body: `{ jwk }`. |
| `DELETE` | `/internal/admin/domains/:domain/jwks/:kid` | Deactivate (soft delete). |

### 6.3 Modified existing

- `GET /.well-known/jwks.json` — returns union of `CONFIG_JWKS_JSON` env (legacy) and all active `client_domain_jwks` rows.
- Config verifier: when resolving a `kid` from a config JWT, look up `client_domain_jwks` first, fall back to the existing remote JWKS resolver.
- Existing Secrets page **Rotate** button: emails a claim link instead of revealing in admin.

## 7. UI (Admin SPA)

### 7.1 New page: `/integrations` ("New Integrations")

Position: nav `Configuration > New Integrations` above `Domains & Secrets`. Badge count = number of `pending` requests.

- Table columns: Domain | Submitted | Status | Contact | Actions
- Status filter: All / Pending / Declined / Accepted
- Row click → side panel detail view
- Detail view sections: Identity (domain, contact, fingerprint), Source (jwks_url, config_url, JWT header), Verified Config (config_summary JSON tree), Pre-validation (issues + recommendations), Decision (Accept / Decline buttons)

### 7.2 Updated page: `/secrets` (rename to `/domains-secrets` later if desired)

- Remove **Add Domain** button (auto-onboarding replaces it).
- Remove the inline secret-paste field on rotation; rotation now triggers an email.
- Add a **Signing Keys** section to the existing edit-domain dialog — paste JWK JSON, fingerprint preview, list of registered kids with deactivate.

### 7.3 New public page

- `/integrations/claim/:token` — server-rendered (Fastify view), same Tailwind look as existing public auth pages. One-time secret reveal + copy buttons + warnings.

## 8. Security

| Concern | Mitigation |
|---|---|
| SSRF via `jwks_url` | Reuse `config-fetch.service.ts` IP allowlist + timeouts + size cap. |
| Spoofed partner submitting random domains | Pending rows are inert; superuser is the trust source. Domain string + JWK fingerprint shown to superuser. Decline-and-block keeps malicious domains from re-entering until manually deleted. |
| JWKS-from-different-host attack | Enforce `URL(jwks_url).hostname === payload.domain` (case-insensitive). |
| Pending-row spam | Unique-on-domain partial index caps to one open row per domain. Existing IP rate limit on `/auth` bounds ingress. |
| Claim token replay | `usedAt` set in the same transaction that returns the secret. `encryptedSecret` nulled out on claim. |
| Claim link leakage from email | 24h expiry, single use, only reveals secret once. Future v2: JWE-wrap the secret to a partner-published `use: enc` JWK to remove the email-channel risk entirely. |
| DB compromise reading the encrypted claim | AES-256-GCM with `SHARED_SECRET` as KEK. Short-lived (24h max). After claim, blob is null. Trade-off accepted: anyone who has the DB AND `SHARED_SECRET` has equivalent access already. |
| Superuser social-engineering attack | Confirm-by-fingerprint in admin UI. Audit log for accept/decline. |

## 9. /llm documentation update

After implementation, `/llm` Phase 0 collapses from "register your JWK with a UOA superuser via env var" to:

> Add `jwks_url` and `contact_email` to your config JWT payload. Make one `/auth` call. Watch for the approval email at `contact_email`. Open the claim link, copy your `client_secret`. Done.

The current Phase 0 keypair generation snippet stays. The env-var dance disappears entirely.

## 10. Out-of-scope follow-ups

- JWE-wrap claim secret to a partner-published `use: enc` JWK.
- Multi-recipient `additional_notification_emails: string[]`.
- Webhook callback alongside email.
- Partner-driven secret rotation request endpoint.
- Per-domain rate limiting on auto-discovery.

## 11. Implementation chunks

The work is split into seven chunks. Each chunk ends in a single commit on `feature/auto-onboarding`. Codex executes the implementation; after each commit, a Claude review agent and a Codex review pass both run for security + correctness.

| # | Chunk | Description |
|---|---|---|
| 1 | DB schema | Prisma models + partial unique index migration + audit log table. |
| 2 | DB-backed JWKS | `client-jwk.service.ts` + `/.well-known/jwks.json` union + verifier kid lookup. Tests. |
| 3 | Auto-discovery | Same-host check + payload `jwks_url`/`contact_email` parsing + pending row creation + friendly page in `/auth` failure path. Tests. |
| 4 | Admin API | `/internal/admin/integration-requests/*` + `/internal/admin/domains/:domain/jwks/*` endpoints with superuser guard + audit log writes. Tests. |
| 5 | Claim flow | Public `/integrations/claim/:token` + AES-256-GCM helper + claim-token sweep + one-time page render + SES email template. Tests. |
| 6 | Admin UI | New Integrations page + Signing Keys section in domain dialog + Rotate flow change. |
| 7 | `/llm` doc + cleanup | Update `/llm` Phase 0, remove obsolete env-var instructions, update `/api` schema. |
