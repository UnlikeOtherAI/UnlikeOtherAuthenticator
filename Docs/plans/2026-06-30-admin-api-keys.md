# Admin API Keys — terminal/CI control of feature flags & kill switches

- **Jira:** HUGO-539
- **Branch:** `hugo-539-admin-api-keys`
- **Status:** spec (pre-implementation)

## Context

Feature flags and kill switches are stored per `App` and written through
`POST/PATCH/DELETE /internal/admin/apps/:appId/{flags,kill-switches}`
(`API/src/routes/internal/admin/apps.ts`). Every `/internal/admin/*` route is guarded by
`requireAdminSuperuser` (`API/src/middleware/admin-superuser.ts`), which requires a **superuser
browser access-token JWT** issued by the admin OAuth flow. That JWT is short-lived and obtained
interactively, so there is **no way to operate a flag or kill switch from a terminal or CI job**.

UOA has **no API-key concept** today. The only long-lived credential is the per-domain client
secret (`uoa_sec_`, `API/src/utils/client-hash.ts` + `API/src/services/domain-secret.service.ts`),
which authenticates `/domain/*` backend calls — not admin operations.

**Outcome we want:** a superuser mints an **Admin API Key** in the Admin panel and uses it from the
terminal (curl/CI) to create and toggle feature flags and kill switches. Turnkey for the operator:
the UI shows ready-to-paste commands the moment the key is created, and `/llm` documents the same.

## Non-goals / guardrails (keep it simple, not over-engineered)

- No per-key rate limiting, IP allowlists, or usage analytics (YAGNI for an internal superuser tool).
- No scope-picker UI: every key carries the same fixed capability set (below). Scopes are stored so a
  read-only key is a trivial future addition, but the create form does not expose them.
- A key **cannot** mint/list/revoke keys and **cannot** touch users, orgs, domains, or superusers.
  Key management stays superuser-UI-only — this is the privilege-escalation boundary.
- Reuse the existing digest pattern; introduce **no new env var** (uses `SHARED_SECRET`).

## Design

### Capability model

A key grants exactly: `apps:read`, `flags:write`, `killswitches:write`. These map to:
- `apps:read` → `GET /internal/admin/apps`, `GET /internal/admin/apps/:appId` (discover app + ids).
- `flags:write` → `POST/PATCH/DELETE …/apps/:appId/flags[/:flagId]`.
- `killswitches:write` → `POST/PATCH/DELETE …/apps/:appId/kill-switches[/:killSwitchId]`.

### 1. Storage — `AdminApiKey` (`API/prisma/schema.prisma`)

```prisma
model AdminApiKey {
  id              String    @id @default(cuid())
  name            String    @db.VarChar(120)
  keyPrefix       String    @db.VarChar(24)            // display hint, e.g. "uoa_ak_AbC123"
  secretDigest    String    @unique                    // HMAC-SHA256(rawKey, SHARED_SECRET) hex
  scopes          Json      @default("[\"apps:read\",\"flags:write\",\"killswitches:write\"]")
  lastUsedAt      DateTime?
  expiresAt       DateTime?
  revokedAt       DateTime?
  createdByUserId String?
  createdByEmail  String?   @db.VarChar(200)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@map("admin_api_keys")
}
```

Secret is **never** persisted — only the HMAC digest, exactly like `ClientDomainSecret.secretDigest`.

### 2. Key util — `API/src/utils/api-key.ts` (new, mirrors `client-hash.ts`)

- `export const API_KEY_PREFIX = 'uoa_ak_'`
- `generateAdminApiKey()` → `uoa_ak_` + `randomBytes(32).toString('base64url')`
- `digestApiKey(rawKey, pepper = requireEnv('SHARED_SECRET').SHARED_SECRET)` → HMAC-SHA256 hex
- `apiKeyDisplayPrefix(rawKey)` → first 14 chars (for the list view)

### 3. Service — `API/src/services/admin-api-key.service.ts` (new)

- `createAdminApiKey({ name, expiresAt?, createdBy })` → `{ record, plaintext }` (plaintext shown once).
- `listAdminApiKeys()` → records without any secret material.
- `revokeAdminApiKey(id)` → set `revokedAt = now()`.
- `verifyAdminApiKey(rawKey)` → compute digest → `findUnique({ where: { secretDigest } })`; reject when
  missing / `revokedAt` set / `expiresAt < now`; best-effort `lastUsedAt` touch (don't fail the request
  if the touch write fails); return `{ id, scopes }`. Indexed digest lookup is forgery-proof — an
  attacker cannot compute the HMAC without `SHARED_SECRET`, so no timing concern beyond the existing
  client-secret path. Uses `getAdminPrisma()` (no tenant context).

### 4. Auth middleware — `API/src/middleware/admin-access.ts` (new)

```ts
export function requireAdminAccess(scope: AdminScope) {
  return async (request, reply) => {
    const apiKey = readApiKeyCredential(request); // X-API-Key header, or Bearer "uoa_ak_…"
    if (apiKey) {
      const verified = await verifyAdminApiKey(apiKey);   // throws 401 on bad/expired/revoked
      if (!verified.scopes.includes(scope)) throw new AppError('FORBIDDEN', 403, 'API_KEY_SCOPE');
      request.adminApiKey = verified;
      return;
    }
    return requireAdminSuperuser(request, reply);          // unchanged JWT path
  };
}
```

`readApiKeyCredential` only treats a Bearer value as an API key when it starts with `uoa_ak_`;
otherwise the existing superuser-JWT path runs untouched (no regression for the Admin UI).

In `API/src/routes/internal/admin/apps.ts`, generalize the local `adminRoute(responseSchema)` helper to
`adminRoute(scope, responseSchema)` and swap `requireAdminSuperuser` → `requireAdminAccess(scope)`.
Apply `apps:read` to the apps GET route(s) (locate the existing GET list/detail handler — sibling of
`apps.ts` under `routes/internal/admin/`), `flags:write` / `killswitches:write` to the write routes.

### 5. Key-management routes — `API/src/routes/internal/admin/api-keys.ts` (new)

`GET /internal/admin/api-keys` · `POST /internal/admin/api-keys` (returns plaintext once) ·
`DELETE /internal/admin/api-keys/:id` (revoke). **All keep `requireAdminSuperuser`.** Register via the
existing `registerInternalAdminRoutes` aggregation in `API/src/routes/index.ts`.

### 6. Admin UI (`Admin/`)

- New page `Admin/src/pages/ApiKeysPage.tsx`; route `/api-keys` in `Admin/src/app/App.tsx`; nav entry.
- `Admin/src/services/admin-service.ts`: `listApiKeys`, `createApiKey`, `revokeApiKey`
  (calls go through `createApiClient()` → Bearer admin token, same as every other admin call).
- Create dialog: **name** (required) + optional **expiry**. On success, a one-time panel shows the
  secret with a Copy button **and copy-ready curl snippets** prefilled with the real key and the
  `sso.hugopos.eu` base URL: (a) list apps, (b) create a flag, (c) flip a kill switch.
- List table: name, key prefix, scopes, last used, expires, status (active / expired / revoked), Revoke.
- TanStack Query for fetch/mutations; Tailwind only; follow `Docs/Admin/architecture-admin.md`.

### 7. Docs — keep `/api` and `/llm` in sync (hard repo rule)

Update `API/src/routes/root/index.ts` (machine-readable schema) and `API/src/routes/root/llm.ts`
(markdown guide): document `X-API-Key` auth, the three key-management endpoints, and a terminal recipe
for toggling a flag / kill switch with a key.

### 8. Tests — Vitest via `app.inject()` (`API/tests/unit/`)

- API key can `POST` a flag and `PATCH` a kill switch (200).
- Revoked key → 401; expired key → 401; unknown key → 401.
- Valid key missing the required scope → 403.
- API key cannot hit `POST /internal/admin/api-keys` (key-mgmt stays superuser-only) → 401/403.
- Superuser JWT still works on the flag/kill-switch routes (regression).
- Service unit: create returns plaintext once; stored digest matches `digestApiKey`.

### 9. Migration

`pnpm --filter @uoa/api exec prisma migrate dev --name admin_api_keys` to author the migration.
The UOA database needs it applied before the prod merge. **Confirm with the user before applying to
prod and before merging** (per the standing rule to confirm prod-affecting steps).

## Verification

- `pnpm --filter @uoa/api test` green (new auth/scope/revoke/expiry + service tests).
- `pnpm --filter @uoa/admin build` green; API-Keys page lists/creates (one-time secret + curl panel)/revokes.
- End-to-end against a running instance: mint a key in the UI → `curl` with `X-API-Key` to create a
  flag and flip a kill switch → confirm via `GET /apps/startup`.
- `GET /api` and `GET /llm` reflect the new auth + endpoints and stay byte-consistent with each other.
