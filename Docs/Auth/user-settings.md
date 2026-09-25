# User Settings — Optional Namespaced Per-User Storage

This document is the authoritative specification for the UOA user settings store. It is
incorporated into the brief by the dated addendum "2026-09-25 User settings" in
`Docs/brief.md`.

---

## Integration quickstart

Your **backend** calls these endpoints with two credentials: your domain hash bearer in
`Authorization`, and the signed-in user's access token in `X-UOA-Access-Token`. `?domain=` must
equal the access token's `domain` claim. You only ever read and write the settings of the user the
access token belongs to.

Save a user's bookmarks (one key, whole value replaced):

```http
PUT /settings/me/browser/bookmarks?domain=browser.example.com
Authorization: Bearer <domain hash token>
X-UOA-Access-Token: <user access token>
Content-Type: application/json

{ "value": [ { "favicon": "https://example.com/favicon.ico", "url": "https://example.com/", "name": "Example" } ] }
```

Set or remove several ecosystem-wide preferences at once (`null` deletes a key; all-or-nothing):

```http
PATCH /settings/me/global?domain=browser.example.com
Authorization: Bearer <domain hash token>
X-UOA-Access-Token: <user access token>
Content-Type: application/json

{ "settings": { "theme": "dark", "locale": "en-GB", "legacyFlag": null } }
```

Read them back:

- `GET /settings/me/browser/bookmarks?domain=…` → `{ ok, namespace, key, value, updated_at }`
- `GET /settings/me/global?domain=…` → `{ ok, namespace, settings: { theme: "dark", … }, updated_at }`
- `GET /settings/me?domain=…` → every namespace plus quota `usage`

Things to know before you ship:

- **Values replace, never merge** — to add one bookmark, send the whole updated list.
- **Everything here is visible to every product the user signs into.** Never store secrets.
  Put product-private preferences in a namespace named after your product.
- **Limits:** 256 KiB per value, 500 keys and 1 MiB per user. Over-limit writes return
  `413 SETTING_VALUE_TOO_LARGE` / `413 SETTINGS_QUOTA_EXCEEDED` and change nothing.
- **Writes** are rate-limited to 600/hour per domain + user.

The machine-readable contract for every route is at `GET /api`; the full rules follow below.

---

## 1. Overview

Any user may optionally have settings stored in UOA. Settings are organised in
**namespaced segments**:

```
user
└── namespace          e.g. "browser", "global"
    └── key            e.g. "bookmarks", "theme"
        └── value      any JSON value
```

Two intended shapes:

- **Structured product data** — namespace `browser`, key `bookmarks`, value an array of
  dictionaries:

  ```json
  [
    { "favicon": "https://example.com/favicon.ico", "url": "https://example.com/", "name": "Example" }
  ]
  ```

- **Ecosystem-wide key/value preferences** — namespace `global`, keys such as
  `theme` → `"dark"`, `locale` → `"en-GB"`, read by every product the user signs into.

Nothing is stored for a user until a product writes something. UOA never interprets
settings values; it only stores and returns them.

---

## 2. Names and values

| Part | Format |
| ---- | ------ |
| Namespace | 1–64 chars, `^[a-z0-9][a-z0-9_.-]{0,63}$` |
| Key | 1–128 chars, `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` |
| Value | Any JSON value except a top-level `null` |

- Both names must start with a letter or digit, which also excludes `__proto__`-style
  keys from ever appearing in a response object.
- A namespace exists only while it has at least one key. Reading an unknown namespace
  returns an empty `settings` object, not a 404.
- Nested `null`s are allowed. A top-level `null` is the PATCH delete marker (§4).
- Refused values: nesting deeper than 32 levels, non-finite numbers, and strings or
  object keys containing NUL (`\u0000`) or an unpaired UTF-16 surrogate (Postgres `jsonb`
  cannot store either).

---

## 3. Storage model and quotas

New Prisma model (additive migration, no changes to existing tables):

```prisma
model UserSetting {
  userId    String   @map("user_id")
  namespace String
  key       String
  value     Json
  sizeBytes Int      @map("size_bytes")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, namespace, key])
  @@map("user_settings")
}
```

- `value` is `jsonb`. `size_bytes` is the UTF-8 length of the serialized value.
- The migration repeats the name formats, the per-value cap and "value is not JSON
  `null`" as `CHECK` constraints.
- `ON DELETE CASCADE`: deleting a user deletes their settings.
- RLS: same classification as `user_avatars` — accessed only through the BYPASSRLS admin
  client on dual-auth paths that run outside a tenant context; `uoa_app` is denied.

Quotas (`config/constants.ts`):

| Limit | Value | Error |
| ----- | ----- | ----- |
| Serialized size of one value | 256 KiB (`USER_SETTINGS_MAX_VALUE_BYTES`) | `413 SETTING_VALUE_TOO_LARGE` |
| Keys per user, all namespaces | 500 (`USER_SETTINGS_MAX_ENTRIES`) | `413 SETTINGS_QUOTA_EXCEEDED` |
| Serialized bytes per user, all namespaces | 1 MiB (`USER_SETTINGS_MAX_TOTAL_BYTES`) | `413 SETTINGS_QUOTA_EXCEEDED` |
| Entries in one PATCH | 1–100 (`USER_SETTINGS_MAX_PATCH_ENTRIES`) | generic 400 |
| Request body | value cap + 16 KiB | generic error envelope — rejected before auth; the shared error handler currently answers Fastify's body-too-large error with `500` on every route |

Both 413 codes are in `PRODUCTION_PUBLIC_ERROR_CODES` so products can tell the user their
storage is full; they reveal nothing beyond the caller's own store. Other validation
failures are the standard generic 400.

---

## 4. Write semantics

- **Replace, never merge.** A PUT, or a PATCH entry, replaces the stored value whole. A
  list such as `bookmarks` is always written as the complete new list.
- **PATCH is atomic.** All upserts and `null`-deletes in one PATCH commit together or not
  at all.
- **Quota is checked after the write, inside the same transaction**, and a violation rolls
  the whole write back. The user row is locked (`SELECT … FOR NO KEY UPDATE`) for the
  duration so concurrent writers for the same user serialize and the check sees every
  committed row.
- Deletes (key or namespace) are idempotent and never hit the quota.

---

## 5. Endpoints

Auth for every route: **domain hash bearer + `X-UOA-Access-Token`**, `?domain=` required
and equal to the access token's `domain` claim — the same dual auth as `/avatar/me`
(`Docs/Auth/avatars.md` §5), without org-features gating. The acting identity is always the
token subject; it is never taken from the path or body.

| Method | Path | Body | Response |
| ------ | ---- | ---- | -------- |
| GET | `/settings/me` | — | `{ ok, namespaces: { [ns]: { [key]: value } }, usage: { entries, size_bytes, max_entries, max_size_bytes } }` |
| GET | `/settings/me/:namespace` | — | `{ ok, namespace, settings: { [key]: value }, updated_at: string \| null }` |
| PATCH | `/settings/me/:namespace` | `{ settings: { [key]: value \| null } }` | same as GET namespace, after the write |
| DELETE | `/settings/me/:namespace` | — | `{ ok, deleted: number }` |
| GET | `/settings/me/:namespace/:key` | — | `{ ok, namespace, key, value, updated_at }`; missing key → generic 404 |
| PUT | `/settings/me/:namespace/:key` | `{ value }` (not `null`) | `{ ok, namespace, key, value, updated_at }` |
| DELETE | `/settings/me/:namespace/:key` | — | `{ ok: true }` |

- `updated_at` on a namespace is the time of its most recent write.
- All responses carry `Cache-Control: no-store`.
- Writes (PATCH, PUT, both DELETEs) share one rate limit: 600/hour keyed per domain + user.

---

## 6. Trust model

Settings belong to the **user row**, not to a product:

- A `global`-scope user is one identity across every domain they sign into, so every one
  of those products sees and can change the same namespaces. That is what makes a shared
  `global` namespace possible.
- A `per_domain`-scope user has a separate user row — and therefore a separate settings
  store — per domain.
- There is no per-namespace ownership: **any product the user signs into can read and write
  every namespace.** Settings must never hold secrets, credentials or tokens. Products
  should keep product-private preferences in a namespace named after the product and treat
  every other namespace as shared.

This mirrors the trust decision already taken for uploaded avatars (one shared image per
`global` user). If per-product isolation is ever needed it would be an additive change
(e.g. a namespace-to-domain binding), not a change to this contract.

---

## 7. Not in scope (yet)

- A `/domain/users/:userId/settings` backend-only path (domain hash bearer without a user
  access token), Admin panel UI and `/internal/admin/*` routes for settings.
- Deep merge / JSON Patch, per-key optimistic concurrency, change feeds.
- Per-product namespace ownership (§6).

## Native public clients

Direct PKCE clients use the scoped, subject-bound `/oauth/me/settings/:namespace/:key`
GET/PUT endpoints described in [native-accounts.md](native-accounts.md). This is an
additional authenticated entry point to the same user-owned store, with conditional
writes to protect read/modify/write lists. The existing confidential dual-auth routes
and their authorization requirements are unchanged.
