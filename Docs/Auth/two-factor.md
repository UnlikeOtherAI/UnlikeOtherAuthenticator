# Two-Factor Authentication — Implementation Spec

Status: **build spec** for the next 2FA iteration. This is the execution guide. It extends — never replaces — `Docs/brief.md` §13. Where the brief and this doc agree, follow the brief; where this doc adds detail (policy model, self-service enrollment, logo'd QR), follow this doc.

## 1. Goal

Make 2FA actually usable end-to-end:

1. **Per-domain** policy — an admin toggle that turns 2FA off / optional / required for a Service (domain).
2. **Per-org** policy — an org-level toggle that can *force* 2FA for its members, overriding a looser domain policy.
3. **User self-service enrollment via API** — a logged-in user can enable 2FA for themselves: get a QR code, scan it in Google Authenticator (or any TOTP app), confirm a code, done. They can also disable it (unless policy forces it on).
4. **Logo'd QR** — the QR returned for enrollment embeds the Service's company logo (from the config `ui_theme.logo.url`), generated with the sibling `@unlikeotherai/qr-art` package.
5. **Two call surfaces** — the same enroll/verify/disable API is reachable both from the **client website / Auth window** (end users) and from the **Admin panel** (system admins managing policy + resetting a user's 2FA).

## 2. What already exists (reuse, do not rebuild)

Backend TOTP is largely built; the gap is the **enrollment endpoint + UI wiring + policy model + logo QR**.

- `API/src/services/totp.service.ts` — secret gen, `buildTotpOtpAuthUri`, `findMatchingTotpCounter`/`verifyTotpCode`, `renderTotpQrCodeDataUrl` (plain QR, **no logo** — to be replaced/extended).
- `API/src/services/twofactor-enroll.service.ts` — `enrollTwoFactorForUser({ userId, totpSecret, code })`. Verifies the code, encrypts + stores the secret, flips `twoFaEnabled`. **Currently has zero callers.** Wire it up.
- `API/src/services/twofactor-login.service.ts` — `verifyTwoFactorForLogin` (counter replay protection).
- `API/src/services/twofactor-challenge.service.ts` — `signTwoFaChallenge` / `verifyTwoFaChallenge`. Short-lived JWT bridging primary auth → `/2fa/verify`. **Mirror this pattern for the setup token.**
- `API/src/services/twofactor-reset.service.ts` + `API/src/routes/twofactor/reset.ts` — email-based recovery. Keep as-is.
- `API/src/utils/twofa-secret.ts` — AES-256-GCM encryption at rest. Reuse for the setup-token secret too.
- `API/src/routes/twofactor/verify.ts` — `POST /2fa/verify`. Keep; login enforcement feeds it.
- Schema: `User.twoFaEnabled / twoFaSecret / twoFaLastAcceptedCounter` (`API/prisma/schema.prisma:38-40`).
- Config flag: `2fa_enabled` (`config.service.ts:192`) — coarse per-client switch (see §3 for how it interacts with the new DB policy).

Auth UI stubs to wire: `Auth/src/components/twofactor/TwoFactorSetup.tsx`, `TwoFactorVerify.tsx`, `QrCodeDisplay.tsx` (all say "API wiring handled in a later task").

## 3. Policy model (the core decision)

Three-state policy, resolved **server-side at login**:

- `off` — 2FA never offered or challenged.
- `optional` — available; the user chooses whether to enroll (today's effective behavior).
- `required` — the user **must** enroll; login is gated into setup until they do, and they cannot self-disable.

### Where it lives

DB-backed, admin-managed (not the config JWT — org-level enforcement does not belong in a per-domain signed config):

- `ClientDomain.twoFaPolicy` — enum `OFF | OPTIONAL | REQUIRED`, default `OPTIONAL`.
- `Organisation.twoFaPolicy` — nullable enum `OFF | OPTIONAL | REQUIRED` (null = inherit from domain). A non-null value escalates only — it never weakens the domain policy below itself.

Add a single Prisma enum (e.g. `TwoFaPolicy`) shared by both. Migration adds the enum + two columns with the defaults above.

### Resolution

```
effective = strongest(domainPolicy, sameDomainOrgPolicies, selectedOrgPolicy)
// REQUIRED > OPTIONAL > OFF
```

The user's orgs are resolved through the existing `org_features` / `OrgMember` path that login already uses for tenant context. If the user belongs to multiple orgs on the domain, take the strongest org policy. Once a workspace is selected, that exact Organisation is included even when a server-recognized product selected it across domains. Recognized products pre-bind their mandatory exact workspace before this decision on password, social, email-code, and email-link paths; `workspace_selection: "off"` suppresses the chooser only.

### Interaction with the legacy `2fa_enabled` config flag

Preserve backward-compat without two competing switches:

- Treat `config['2fa_enabled'] === false` as a hard master-off for that client request: if the config flag is false, `effective = OFF` regardless of DB policy. (Existing clients that never set it keep today's behavior.)
- When `config['2fa_enabled'] === true`, the DB policy (`OFF/OPTIONAL/REQUIRED`) decides. Document this precedence in `config-docs.ts` and `/llm`.

(If the team later wants the DB policy to fully own the decision, that's a follow-up; for this iteration the config flag remains the master gate to avoid surprising live integrations.)

## 4. API — endpoint contracts

All user-facing endpoints run behind `configVerifier` (signed config required) **and** access-token auth (`X-UOA-Access-Token`, verified via `access-token.service.ts`/`verifyAccessToken`). All errors are generic (`AppError` → `{ error: "Request failed" }`); never leak "wrong code" / "already enrolled" specifics to the user. Rate-limit setup/enroll/disable like `twoFactorVerifyRateLimiter`.

### 4.1 `POST /2fa/setup` (user self-service)

Starts enrollment for the authenticated user. Generates a fresh TOTP secret (does **not** enable yet).

- Returns:
  - `otpauth_uri` — from `buildTotpOtpAuthUri({ secret, issuer: config domain/label, accountName: user email })`.
  - `qr_svg` — data URL, **logo embedded** (see §5).
  - `setup_token` — short-lived signed JWT (mirror `signTwoFaChallenge`) carrying `{ userId, encryptedSecret, domain, configUrl }`. TTL ~10 min. The raw secret is **not** returned in a trusted field for re-submission; the server recovers it from `setup_token` on enroll. (Showing the base32 secret as manual-entry fallback text is fine, but enrollment trust comes from the token.)
- Guard: if `effective === OFF`, 404/generic-fail. If the user is already `twoFaEnabled`, generic-fail (they must disable first).

### 4.2 `POST /2fa/enroll` (user self-service)

Body: `{ setup_token, code }`. Verifies the challenge token, decrypts the secret, calls `enrollTwoFactorForUser({ userId, totpSecret, code })`. On success `twoFaEnabled = true`. Returns `{ ok: true }`.

### 4.3 `POST /2fa/disable` (user self-service)

Body: `{ code }` (a current TOTP code; reuse `verifyTwoFactorForLogin` semantics). Flips `twoFaEnabled=false`, clears `twoFaSecret` + counter, revokes refresh tokens (reuse the reset service's revocation). **Blocked when `effective === REQUIRED`** → generic-fail (mandatory users can't opt out).

### 4.4 `POST /2fa/verify` (existing)

Unchanged contract. Login enforcement (below) issues the `twofa_token` that this consumes.

### 4.5 Login enforcement (modify existing routes)

In `API/src/routes/auth/login.ts`, `API/src/routes/oauth/login.ts`, `API/src/routes/auth/callback.ts` (social), replace `if (config['2fa_enabled'] && twoFaEnabled)` with policy-aware logic:

1. Compute `effective` (§3).
2. If `effective === OFF` → no 2FA, proceed.
3. If `user.twoFaEnabled` → issue `twofa_token` (existing `signTwoFaChallenge`), return `{ kind: 'twofa', twofa_token }`. Client calls `/2fa/verify`.
4. If `effective === REQUIRED` and **not** enrolled → **do not grant an auth code**. Return `{ kind: 'twofa_enroll_required', setup_token }` (issue the §4.1 setup token here so the Auth UI can route straight into forced setup). Tokens are granted only after `/2fa/enroll` succeeds, which then issues the auth code via the normal `finalizeAuthenticatedUser` path.
5. If `effective === OPTIONAL` and not enrolled → proceed normally (user's choice).

Authorization-code issuance persists whether this interactive login completed TOTP. Code exchange
locks/revalidates the exact ACTIVE workspace, resolves the current strongest policy and enrollment,
and rejects a proof-free code if proof is now required. The rejection rolls code consumption back
and creates no refresh/access-token family, closing policy and membership changes between the
interactive step and exchange.

### 4.6 Admin endpoints (system admin only, `/internal/admin/*`, audited)

- `PATCH /internal/admin/domains/:domain` — accept `twoFaPolicy` (extend existing domain-update path).
- `PATCH /internal/admin/organisations/:id` — accept `twoFaPolicy`.
- `GET` domain/org/user detail responses — include the policy + (for users) `twoFaEnabled` status.
- `POST /internal/admin/users/:id/2fa/disable` — admin reset of a user's 2FA (clear secret + flip flag + revoke refresh tokens). Write an `AdminAuditLog` row. Admin **cannot** view secrets or enroll on a user's behalf (the user must scan their own QR).

## 5. Logo'd QR via `@unlikeotherai/qr-art`

Sibling repo at `/System/Volumes/Data/.internal/projects/Projects/QR`, package `@unlikeotherai/qr-art`, API `renderSVG(text, { size, shape, cornerRadius, mask, logo: { src, overlay, sizeRatio, padding, borderRadius } })`.

- Add the dependency (prefer the published package `@unlikeotherai/qr-art`; fall back to the GitHub repo `UnlikeOtherAI/qr-art` as a git dependency if not on the registry). pnpm.
- New server helper (keep `totp.service.ts` under 500 lines — put this in a small `totp-qr.service.ts` or similar): `renderTotpQrSvg({ otpAuthUri, logoUrl })` → returns a `data:image/svg+xml;base64,...` URL.
  - `logoUrl` = `config.ui_theme.logo.url` (already same-origin-validated against the config domain in `config.service.ts`). If absent/empty, render without a logo.
  - **Node embedding caveat:** verify `renderSVG` produces a self-contained SVG in Node. A remote `logo.src` URL may render as `<image href="https://…">` (not self-contained) — if so, **fetch the logo server-side and inline it as a base64 data URI** before passing to `renderSVG`, so the returned SVG needs no external fetch when displayed on the client site. `makeLogoBackgroundTransparent` is browser-only — do not use it server-side.
- This replaces `renderTotpQrCodeDataUrl` usage in the enrollment path; keep the old function or fold it in, but the enrollment QR must be the logo'd one.

## 6. Auth UI wiring (`/Auth`)

- `TwoFactorSetup.tsx` — on mount (or on entering forced setup): call `/2fa/setup`, render `qr_svg` via `QrCodeDisplay`, show manual-entry secret fallback, POST the 6-digit code to `/2fa/enroll` with the `setup_token`. On success, continue the auth flow (forced path → resume token grant).
- `TwoFactorVerify.tsx` — POST `{ twofa_token, code }` to `/2fa/verify`; on success follow `redirect_to` / consume the auth code.
- Routing: `PopupContainer.tsx` already renders `TwoFactorVerifyPage` for the verify state. Add the `twofa_enroll_required` state → render `TwoFactorSetupPage` and block exit until enrolled.
- i18n: keys already exist under `twoFactor.*` / `auth.twoFactor*` in `en.ts` / `es.ts`; add any missing strings to **both** locales.

## 7. Admin UI wiring (`/Admin`)

- **Service (domain) detail** — a 2FA policy selector (Off / Optional / Required) wired to `PATCH /internal/admin/domains/:domain`.
- **Organisation detail** — a 2FA policy selector (Inherit / Optional / Required) wired to `PATCH /internal/admin/organisations/:id`.
- **User detail** — show 2FA status; a "Reset 2FA" action → `POST /internal/admin/users/:id/2fa/disable` with a confirm step.
- Keep components ≤500 lines, one component per file, Tailwind-only, follow `Docs/Admin/architecture-admin.md`.

## 8. Contract docs (must stay in sync)

When endpoints/config change, update **both**:

- `API/src/routes/root/index.ts` (and `schema.auth.ts`) — machine-readable `/api` schema: add `/2fa/setup`, `/2fa/enroll`, `/2fa/disable`, the admin policy/disable routes.
- `API/src/routes/root/llm.ts` (+ `llm-intro.ts`, `config-docs.ts`) — `/llm` guide + config field docs: document the policy model and the `2fa_enabled` precedence (§3).
- `Docs/brief.md` — **add** a clarification subsection under §13 describing the policy model and self-service enrollment. Add only; do not rewrite existing 2FA text.

## 9. Security checklist

- Secrets encrypted at rest (existing AES-256-GCM util); never returned in plaintext after enrollment; never exposed to admins.
- All user-facing 2FA errors generic; no enumeration of account / enrollment state.
- Counter replay protection preserved (`twoFaLastAcceptedCounter`).
- Rate-limit setup/enroll/disable/verify.
- Forced (`REQUIRED`) users cannot self-disable.
- Admin disable/reset writes `AdminAuditLog`.
- No backup codes (brief §20). Email reset remains the only self-recovery path.
- Setup token: short TTL, bound to `userId + domain + configUrl`, single-purpose audience.

## 10. Tests (headless)

- Unit: policy resolution (`strongest(domain, org)`, legacy-flag master-off), QR helper (logo + no-logo), setup-token sign/verify.
- Integration: setup→enroll happy path; enroll with wrong code → generic fail; forced-enrollment gating (REQUIRED + not enrolled blocks token grant); optional path proceeds; disable blocked when REQUIRED; admin reset clears secret + revokes refresh tokens + audits; per-domain and per-org policy PATCH.
- Migration applies cleanly (enum + columns + defaults). Mind prod migrator ownership (`uoa_admin`) at deploy.

## 11. Build order

1. Prisma: `TwoFaPolicy` enum + `ClientDomain.twoFaPolicy` + `Organisation.twoFaPolicy` + migration.
2. Policy resolution service (pure, unit-tested).
3. `@unlikeotherai/qr-art` dependency + `renderTotpQrSvg` helper (logo).
4. Setup-token service (mirror challenge service) + `/2fa/setup`, `/2fa/enroll`, `/2fa/disable` routes (register in `routes/twofactor/index.ts`).
5. Login enforcement edits (login / oauth / social callback) incl. `twofa_enroll_required`.
6. Admin endpoints (domain/org PATCH, user reset) + audit.
7. Auth UI wiring (setup/verify/forced) + i18n.
8. Admin UI wiring (policy selectors + user reset).
9. `/api` + `/llm` + `config-docs` + brief §13 clarification.
10. Tests; run lint + typecheck + test for API, Auth, Admin.
