# Super-users & Per-Domain Email — Implementation Plan

Date: 2026-04-23
Owner: Ondrej
Status: Spec agreed — ready to implement

Two independent features, planned together so they can share the same admin-panel changes.

---

## Feature 1 — Super-user management page

### Goal
A page in the admin panel, visible only to existing super-users, to list, search for, grant, and revoke super-user access.

### Definition
"Super-user" = `DomainRole` row with `role = SUPERUSER` on the admin domain configured via `ADMIN_AUTH_DOMAIN`. These are the only users who can authenticate into `/internal/admin/*`. Per-tenant-domain `SUPERUSER` rows (the first-login-bootstraps-superuser pattern in `domain-role.service.ts`) are a separate concept and not touched by this feature.

### API — all under `/internal/admin/superusers`, all gated by `requireAdminSuperuser`

```
GET    /internal/admin/superusers
       → [{ userId, email, name, createdAt }]

GET    /internal/admin/superusers/search?q=<free text>
       → [{ userId, email, name }]
       Fuzzy search across all UOA users (email + name). Excludes users who
       already hold SUPERUSER on the admin domain. Limit 20.

POST   /internal/admin/superusers
       body: { userId: string }
       → 201 { userId, email, name, createdAt }
       Upserts DomainRole (domain = ADMIN_AUTH_DOMAIN, userId, role = SUPERUSER).
       Idempotent — re-granting an existing super-user returns the existing row.

DELETE /internal/admin/superusers/:userId
       → 204
       Refuses to remove the caller (self).           → 409 CANNOT_REMOVE_SELF
       Refuses to remove the last remaining super-user.→ 409 CANNOT_REMOVE_LAST_SUPERUSER
```

All responses follow the repo's generic-error convention — clients never see why a request failed beyond the generic message.

### API files
- new `API/src/routes/internal/admin/superusers.ts`
- registered in `API/src/routes/internal/admin/index.ts`
- new service helpers in `API/src/services/internal-admin.service.ts` (or split into `superusers.service.ts` if the file exceeds 500 lines) — `listAdminSuperusers`, `searchNonSuperusers`, `grantAdminSuperuser`, `revokeAdminSuperuser`
- schema + llm docs: append entries to `API/src/routes/root/schema.internal-admin.ts` and `API/src/routes/root/llm.ts`

### Admin UI
- new page `Admin/src/pages/SuperUsersPage.tsx`
  - table of current super-users (email, name, created date, remove button)
  - search input wired to `/internal/admin/superusers/search`
  - results list with "Grant super-user" action
  - confirmation dialog for revoke
- sidebar entry added wherever `DashboardPage`/`UsersPage` links live (search for the sidebar config file during implementation)
- route added in `Admin/src/app/App.tsx`: `<Route path="superusers" element={<SuperUsersPage />} />`
- queries added to `Admin/src/features/admin/admin-queries.ts`

### Tests
- unit tests for the three service functions (list/search/grant/revoke), including both 409 safety rails
- route tests mirroring the style of existing `admin-superuser.test.ts`

---

## Feature 2 — Per-domain email sending

### Goal
Let any registered UOA domain opt into sending arbitrary transactional emails through UOA-managed SES. Enablement and DNS registration happen in the admin panel (super-user only). Sending is done by the customer's backend calling a single endpoint, authenticated by a config JWT carried **in the request itself** — no `config_url` round trip.

### Design summary
- **Enablement**: per-domain row in a new `DomainEmailConfig` table, toggled via admin panel. No signed-config changes, no changes to `ClientConfigSchema`.
- **Sender identity**: configured per-domain in the admin panel (`mailingDomain`, `fromAddress`, optional `fromName`, optional `replyToDefault`). No constraint linking `mailingDomain` to the UOA domain — sole-admin trust model for now.
- **SES domain registration**: automated via a new AWS IAM key with identity-management permissions. Super-user clicks "Register sender" → UOA calls SES, returns TXT + DKIM records for the admin to paste into their DNS, stores pending status, re-polls on demand.
- **Send auth**: config JWT passed in an `X-UOA-Config-JWT` header, verified against the domain's JWKS (already cached in `configJwksCache`). No fetch-back.
- **Template**: none. Client supplies `subject`, `text`, optional `html`, optional `reply_to`.
- **Rate limiting**: none in v1.

### Database — new Prisma model

```prisma
model DomainEmailConfig {
  domain            String   @id
  enabled           Boolean  @default(false)
  mailingDomain     String?
  fromAddress       String?
  fromName          String?
  replyToDefault    String?
  sesRegion         String   @default("eu-west-1")
  sesVerification   String?   // "Pending" | "Success" | "Failed" | null before register
  sesDkim           String?   // same
  dkimTokens        String[]  @default([])   // 3 tokens returned by VerifyDomainDkim
  lastCheckedAt     DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  domainRef         Domain   @relation(fields: [domain], references: [domain], onDelete: Cascade)
}
```

`Domain` model gains `emailConfig DomainEmailConfig?` back-relation.

Migration: new table + FK. No data backfill.

### Env vars

New (optional — fall back to existing send-only key if absent):
```
AWS_SES_ADMIN_ACCESS_KEY_ID       — key with ses:VerifyDomainIdentity, ses:VerifyDomainDkim,
AWS_SES_ADMIN_SECRET_ACCESS_KEY     ses:SetIdentityDkimEnabled, ses:SetIdentityMailFromDomain,
                                    ses:GetIdentityVerificationAttributes,
                                    ses:GetIdentityDkimAttributes
AWS_SES_ADMIN_REGION              — default "eu-west-1"
```

The existing `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` continue to handle `ses:SendEmail`. Sending from a verified identity requires only `ses:SendEmail` on that identity, which the existing key has.

If `AWS_SES_ADMIN_*` is unset, the admin panel's "Register sender" button is disabled with a clear explanation. Send still works for already-verified domains.

### Admin API (super-user only)

```
GET    /internal/admin/domains/:domain/email
       → { config, liveStatus: { verification, dkim }, dnsRecords }
       Reads DB config and, if registered, re-fetches live SES status.

PUT    /internal/admin/domains/:domain/email
       body: { mailingDomain, fromAddress, fromName?, replyToDefault? }
       → 200 { config }
       Upsert. Does NOT call SES. Validates that fromAddress ends with
       @<mailingDomain> (basic sanity check).

POST   /internal/admin/domains/:domain/email/register
       → 200 { verification: { record }, dkim: [ { cname, value } x3 ] }
       Calls SES VerifyDomainIdentity + VerifyDomainDkim + SetIdentityDkimEnabled
       for mailingDomain. Stores dkimTokens, sets status to "Pending".

POST   /internal/admin/domains/:domain/email/refresh
       → 200 { verification, dkim }
       Re-polls SES and updates status fields.

PATCH  /internal/admin/domains/:domain/email/enabled
       body: { enabled: boolean }
       → 200 { config }
       Toggles the enabled flag. Refuses to enable unless verification and DKIM
       are both "Success".

DELETE /internal/admin/domains/:domain/email
       → 204
       Deletes the DB row. Does NOT touch SES — leaves the identity in AWS for
       manual cleanup via the AWS console.
```

All four state fields (`enabled`, `sesVerification`, `sesDkim`, and the stored fields) must be consulted at send time. A row can exist with `enabled = false` — that's an admin deliberately disabling sends without tearing down the identity.

### Public send API

```
POST /email/send
headers:
  X-UOA-Config-JWT: <signed config JWT>
  Content-Type: application/json
body:
  {
    "to": "user@example.com",
    "subject": "Your invitation",
    "text": "Hi…",
    "html": "<p>Hi…</p>",        // optional
    "reply_to": "team@acme.com"  // optional; overrides replyToDefault
  }

→ 202 { ok: true }
→ 401 generic    (missing / invalid / expired JWT)
→ 403 generic    (domain not configured, not enabled, or SES not verified)
→ 400 generic    (invalid body)
→ 500 generic    (send failure — client sees generic; operator sees logs)
```

Flow:
1. New middleware `configJwtHeaderVerifier` reads `X-UOA-Config-JWT`, verifies signature via the domain's JWKS (cached), decodes, validates config shape using the existing `validateConfigFields` / `assertConfigDomainMatchesConfigUrl`-equivalent logic, attaches `request.config`. No HTTP fetch.
2. Handler loads `DomainEmailConfig` for `request.config.domain`. Require: row exists, `enabled = true`, `sesVerification = "Success"`, `sesDkim = "Success"`, `fromAddress` set.
3. Build `EmailMessage` with `from` = `"<fromName> <fromAddress>"` (or just `fromAddress` if no `fromName`), `replyTo` = request `reply_to` ?? `replyToDefault` ?? env `EMAIL_REPLY_TO`.
4. Dispatch via existing `getProvider().send(...)`. The existing SES provider already accepts per-message `from` / `replyTo` overrides.
5. Return 202 on success. Failures follow the generic-error rule.

### Header-based config-JWT middleware
New file `API/src/middleware/config-jwt-header-verifier.ts`. Extracts `X-UOA-Config-JWT`, runs it through `verifyConfigJwtSignature` + `validateConfigFields` (reusing the helpers already exported from `config.service.ts`), attaches `request.config`. Reuses the existing JWKS cache in `config.service.ts`. Does not fetch `config_url`.

We keep the existing URL-based `configVerifier` untouched — the new middleware is additive.

### Email service changes
- `email.service.ts` gains `sendRawEmail({ to, subject, text, html, from, fromName, replyTo })`. Internally calls `dispatchEmail` with no template.
- No changes to `email.providers.ts` expected — `EmailMessage.from` / `replyTo` are already optional per-message.

### SES admin service
New `API/src/services/ses-admin.service.ts`:
```ts
export type SesRegistration = {
  verification: { record: string; status: string };
  dkim: { cname: string; value: string }[];
};

export async function registerSesSender(domain: string): Promise<SesRegistration>;
export async function getSesStatus(domain: string): Promise<{ verification: string; dkim: string }>;
```
Uses `@aws-sdk/client-ses` (already a dependency) with credentials from `AWS_SES_ADMIN_*` falling back to `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

### Domain-email config service
New `API/src/services/domain-email-config.service.ts`:
- `getDomainEmailConfig(domain)` — DB lookup + optional SES refresh
- `upsertDomainEmailConfig(domain, fields)`
- `registerDomainEmailSender(domain)` — calls SES admin service, persists status + tokens
- `refreshDomainEmailStatus(domain)` — re-polls SES, updates DB
- `setDomainEmailEnabled(domain, enabled)` — with verification guard
- `deleteDomainEmailConfig(domain)`

### Admin UI
- New component `Admin/src/features/admin/DomainEmailSection.tsx` (separate file to stay under 500 lines per repo rule) — the full email config form and status panel.
- Section rendered inside existing `DomainDetailPage.tsx`.
- Form fields: mailing domain, from address, from name, default reply-to, enabled toggle.
- After save, a "Register sender" button becomes active. Clicking it surfaces the DNS records to copy. "Refresh status" button re-polls SES.
- Status pills for verification + DKIM (Pending / Success / Failed). "Enabled" toggle disabled until both are Success.
- Queries added to `Admin/src/features/admin/admin-queries.ts`.

### Public docs
- `routes/root/schema.ts` — add `/email/send` entry
- `routes/root/llm.ts` — add human-readable instructions for `/email/send` and the new `X-UOA-Config-JWT` header pattern

### Operational docs
- `Docs/brief.md` — append a new section describing per-domain email sending (never remove, only add)
- `Docs/ses.md` — append the extra IAM policy required for the admin key
- `Docs/Admin/architecture-admin.md` — mention Super-users page and Email section on Domain detail

---

## Env variable additions (summary)

```
AWS_SES_ADMIN_ACCESS_KEY_ID       optional; enables "Register sender" flow
AWS_SES_ADMIN_SECRET_ACCESS_KEY   optional; enables "Register sender" flow
AWS_SES_ADMIN_REGION              optional; defaults to "eu-west-1"
```

No breaking env changes. Existing deployments keep working.

---

## Build order

1. DB migration for `DomainEmailConfig`.
2. SES admin service + env var plumbing.
3. Domain-email config service + admin API routes.
4. Super-users admin API routes.
5. Header-based config JWT middleware.
6. Public `/email/send` route + service wiring.
7. Admin UI: Super-users page, Email section on Domain detail.
8. Tests (service-level + route-level) throughout.
9. Schema + llm docs updates.
10. `brief.md`, `ses.md`, admin architecture doc updates.
11. Manual smoke test: register a domain, paste DNS records, refresh until Success, enable, send a test email.

---

## Design decisions (confirmed)

| Question | Answer |
|---|---|
| Super-user scope | Admin-domain `SUPERUSER` only |
| Rate limiting | None in v1 |
| Templates | None — raw subject / text / html |
| From address source | Per-domain admin-panel config; no constraint to the UOA domain |
| fromAddress format | Must end with `@<mailingDomain>` — basic sanity check |
| SES region | `eu-west-1` (Ireland) default; overridable via env |
| Send auth | `X-UOA-Config-JWT` header, verified against the domain's JWKS — no `config_url` round trip |
| Reply-to | Per-send override allowed; falls back to `replyToDefault` → `EMAIL_REPLY_TO` |
| SES identity cleanup on delete | Leave in AWS; admin handles manually |
| Enable toggle guard | Refuses to enable unless verification + DKIM are both "Success" |

---

## Out of scope

- Bulk / batched sending
- Scheduled sends
- Bounce / complaint webhook handling (handled manually via AWS console for now)
- Template system (to be added later if needed)
- Per-domain rate limits
- Tracking pixels / open / click tracking beyond what `team-invites` already has
- A separate "Email sending" top-level admin page — it's a section on the Domain detail page
