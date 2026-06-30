# Admin API Keys — terminal/CI control of feature flags & kill switches

- **Jira:** HUGO-539
- **Branch:** `hugo-539-admin-api-keys`
- **Status:** spec v3 (post spec-review rounds 1–2; reviewed by 1 Claude + 1 Codex worker)

## Context

Feature flags and kill switches are stored per `App` and written through
`POST/PATCH/DELETE /internal/admin/apps/:appId/{flags,kill-switches}`
(`API/src/routes/internal/admin/apps.ts`). Every `/internal/admin/*` route is guarded by
`requireAdminSuperuser` (`API/src/middleware/admin-superuser.ts`), which requires a **superuser
browser access-token JWT** issued by the admin OAuth flow — short-lived and obtained interactively,
so there is **no way to operate a flag or kill switch from a terminal or CI job**.

UOA has **no API-key concept** today. The per-domain client secret (`uoa_sec_`,
`API/src/utils/client-hash.ts` + `API/src/services/domain-secret.service.ts`) authenticates
`/domain/*` calls only. (`Docs/Requirements/roles-and-acl.md` §253 specs an org-scoped **SCIM bearer
token** — opaque, hashed-at-rest, shown once, revocable — but it is not implemented. Our Admin API
Key shares that lifecycle shape; it is **global/superuser-scoped**, not org-scoped, which is the
deliberate difference.)

**Outcome:** a superuser mints an **Admin API Key** in the Admin panel and uses it from the terminal
(curl/CI) to list apps and create/toggle feature flags and kill switches. Turnkey: the UI shows
ready-to-paste commands the moment the key is created, and `/llm` documents the same.

## Guardrails (keep it simple — both spec reviewers flagged over-engineering risk)

- **One fixed capability per key**, no scope-picker UI and **no `scopes` column**. A valid key can do
  exactly what the guarded routes allow (list apps + write flags + write kill switches). The security
  boundary is *which routes* carry the combined guard — every other `/internal/admin/*` route stays
  `requireAdminSuperuser`. If a read-only key is ever needed, that's a future migration (YAGNI).
- A key **cannot** mint/list/revoke keys and **cannot** reach users, orgs, domains, superusers,
  dashboard, settings, logs, or search. Key management is superuser-UI-only — the escalation boundary.
- **No new env var** (reuses `SHARED_SECRET`). No per-key rate limits / IP allowlists / usage analytics.

## Design

### 1. Storage — `AdminApiKey` (`API/prisma/schema.prisma`)

```prisma
model AdminApiKey {
  id              String    @id @default(cuid())
  name            String    @db.VarChar(120)
  keyPrefix       String    @map("key_prefix") @db.VarChar(24)   // display hint, e.g. "uoa_ak_AbC123"
  secretDigest    String    @unique @map("secret_digest")        // HMAC-SHA256(rawKey, SHARED_SECRET) hex
  lastUsedAt      DateTime? @map("last_used_at")
  expiresAt       DateTime? @map("expires_at")
  revokedAt       DateTime? @map("revoked_at")
  createdByUserId String?   @map("created_by_user_id")
  createdByEmail  String?   @map("created_by_email") @db.VarChar(200)
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  @@map("admin_api_keys")
}
```

Secret is **never** persisted — only the HMAC digest (storage like `ClientDomainSecret.secretDigest`;
verification is a global unique-index lookup, a deliberate global-key pattern — *not* the per-domain
scan + `timingSafeEqual` of `domain-secret.service.ts`).

### 2. Key util — `API/src/utils/api-key.ts` (new, mirrors `client-hash.ts`)

- `export const API_KEY_PREFIX = 'uoa_ak_'`
- `generateAdminApiKey()` → `uoa_ak_` + `randomBytes(32).toString('base64url')`
- `digestApiKey(rawKey, pepper = requireEnv('SHARED_SECRET').SHARED_SECRET)` → HMAC-SHA256 hex
- `apiKeyDisplayPrefix(rawKey)` → first 14 chars (list view)

### 3. Service — `API/src/services/admin-api-key.service.ts` (new)

- `createAdminApiKey({ name, expiresAt?, createdBy })` → `{ record, plaintext }` (plaintext shown once).
- `listAdminApiKeys()` → records (no secret material).
- `revokeAdminApiKey(id)` → set `revokedAt = now()`.
- `verifyAdminApiKey(rawKey)` → **guard `if (!getEnv().DATABASE_URL) throw new AppError('UNAUTHORIZED', 401)`**
  (matches `admin-superuser.ts` / `domain-secret.service.ts`), then digest →
  `findUnique({ where: { secretDigest } })`; reject when missing / `revokedAt` set / `expiresAt < now`;
  best-effort `lastUsedAt` touch wrapped in **awaited try/catch** (never fire-and-forget — an
  unhandled rejection must not crash the process; swallow touch errors); return `{ id }`. Uses
  `getAdminPrisma()` (no tenant context). Forgery-proof: the HMAC needs `SHARED_SECRET`.

### 4. Auth middleware — `API/src/middleware/admin-access.ts` (new)

```ts
declare module 'fastify' {
  interface FastifyRequest { adminApiKey?: { id: string } }   // mirrors admin-superuser.ts augmentation
}

export function requireAdminApiKeyOrSuperuser() {
  return async (request, reply) => {
    const apiKey = readApiKeyCredential(request);   // X-API-Key, else Bearer "uoa_ak_…"; reject array/dup headers
    if (apiKey) {
      request.adminApiKey = await verifyAdminApiKey(apiKey);   // invalid key → 401, NEVER falls back to JWT
      return;
    }
    return requireAdminSuperuser(request, reply);   // unchanged JWT path (Bearer not starting with uoa_ak_)
  };
}
```

- **Precedence:** an API-key credential, when present, is authoritative — a bad/expired/revoked key
  returns a generic 401, it does **not** retry as a JWT. Only requests with *no* API-key credential
  fall through to the superuser JWT path, so the Admin UI is unaffected.
- In `API/src/routes/internal/admin/apps.ts` the local `adminRoute(...)` helper is **shared** and also
  guards `POST /internal/admin/apps` (app creation). **Do not swap the shared helper wholesale** — that
  would let an API key create apps. Instead add a second helper `keyedRoute(responseSchema)` whose
  preHandler is `requireAdminApiKeyOrSuperuser()`, and apply it **only** to: the flag write routes
  (POST/PATCH/DELETE flags), the kill-switch write routes (POST/PATCH/DELETE kill-switches), and the
  new `GET /internal/admin/apps` (§5). Leave `POST /internal/admin/apps` on the superuser-only
  `adminRoute(...)`. **Do not touch `read.ts`** (dashboard/settings/users/domains/logs/search stay
  superuser-only). Net: a key reaches exactly flags + kill switches + apps-list; nothing else.

### 5. New read route for discovery — `GET /internal/admin/apps` (in `apps.ts`)

Required because **no GET apps route exists today** (app data is only embedded in
`GET /internal/admin/dashboard` / `/settings`). Add `GET /internal/admin/apps` registered with the new `keyedRoute(...)` helper
(`requireAdminApiKeyOrSuperuser()`), returning the apps list (each with its flags + kill switches, via
the existing `getAdminApps()` in `API/src/services/internal-admin.service.apps.ts`). This gives a
terminal user every id they need. Skip `GET /:appId` (the list already includes everything — keep it
to one new route).

### 6. Key-management routes — `API/src/routes/internal/admin/api-keys.ts` (new)

`GET /internal/admin/api-keys` · `POST /internal/admin/api-keys` (returns plaintext once) ·
`DELETE /internal/admin/api-keys/:id` (revoke). **All keep `requireAdminSuperuser`.** Register via the
existing `registerInternalAdminRoutes` aggregation in `API/src/routes/index.ts`.

### 7. Migration — `API/prisma/migrations/<ts>_admin_api_keys/migration.sql`

Author via Prisma, then **hand-add the admin-only grants** (the RLS migration
`20260423000000_rls_roles_and_grants` grants future tables to `uoa_app` by default, so a secret table
must be locked down explicitly, like the other admin-only tables):

```sql
REVOKE ALL ON TABLE "admin_api_keys" FROM "uoa_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "admin_api_keys" TO "uoa_admin";
-- belt-and-braces, matching the other admin-only secret tables (migration 20260423000001 §3):
-- if a future migration ever grants uoa_app a privilege here, the deny-all policy still blocks it.
ALTER TABLE "admin_api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_api_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_api_keys_deny_app ON "admin_api_keys" FOR ALL TO uoa_app USING (false) WITH CHECK (false);
```

The UOA database needs this applied before the prod merge. **Confirm with the user before applying to
prod and before merging.**

### 8. Admin UI (`Admin/`)

- New page `Admin/src/pages/ApiKeysPage.tsx`; route `/api-keys` in `Admin/src/app/App.tsx`;
  **nav entry + label in `Admin/src/layouts/navigation.ts`** (the real nav/topbar source — add an
  "API Keys" item under the System or Flags section, and a `navLabelForPath` case).
- Add `listApiKeys` / `createApiKey` / `revokeApiKey` **as methods on the `adminService` object** in
  `Admin/src/services/admin-service.ts` (snake_case response types like `DomainSecretResponse`); calls
  go through `createApiClient()` (Bearer admin token).
- Create dialog: **name** (required) + optional **expiry**. On success, a one-time panel shows the
  secret with a Copy button **and copy-ready curl snippets built from `window.location.origin`**
  (list apps, create a flag, flip a kill switch). List table: name, prefix, last used, expires,
  status (active / expired / revoked), Revoke. TanStack Query; Tailwind only.

### 9. Docs — keep `/api` and `/llm` in sync (hard repo rule)

Update the **split schema source** `API/src/routes/root/schema.internal-admin-apps.ts` (and its
aggregation `schema.internal-admin.ts`) for the machine-readable `/api`, and the **markdown source**
`API/src/routes/root/llm-integration.ts` (+ `llm-intro.ts` if a new top-level section is warranted)
for `/llm` — *not* `root/index.ts` / `root/llm.ts` directly. Document `X-API-Key` auth, the new
`GET /internal/admin/apps`, the three key-management endpoints, and a terminal recipe for toggling a
flag / kill switch.

### 10. Tests — Vitest via `app.inject()` (`API/tests/unit/`)

- API key can `GET /internal/admin/apps`, `POST` a flag, and `PATCH` a kill switch (200).
- Revoked / expired / unknown key → 401; invalid API key does **not** fall back to JWT.
- API key cannot hit `POST /internal/admin/apps` (app creation), `POST /internal/admin/api-keys`, or
  any `read.ts` route (all superuser-only) → 401.
- Superuser JWT still works on the flag/kill-switch routes (regression).
- Service unit: create returns plaintext once; stored digest matches `digestApiKey`.

## Verification

- `pnpm --filter @uoa/api test` green (new auth/revoke/expiry + service tests).
- `pnpm --filter @uoa/admin build` green; API-Keys page lists/creates (one-time secret + curl panel)/revokes.
- End-to-end against a running instance: mint a key in the UI → `curl -H "X-API-Key: …"` to
  `GET /internal/admin/apps`, create a flag, flip a kill switch → confirm via `GET /apps/startup`.
- `GET /api` and `GET /llm` reflect the new auth + endpoints and stay consistent with each other.
