# Row Level Security (RLS) — Implementation Plan

Status: draft
Owner: superuser-only infrastructure change
Depends on: `feature/auto-onboarding` merged to `main` (chunks 1–4 add `client_domain_jwks`, `client_domain_integration_requests`, `integration_claim_tokens`, `admin_audit_log`).

## 1. Goal

Enforce tenant isolation at the PostgreSQL layer as **defense-in-depth**. RLS is not a replacement for the app-level checks already in middleware and services — it is the backstop that keeps a forgotten `WHERE org_id = ?` from leaking rows across organisations or across client domains.

## 2. Non-goals

- RLS is not the primary authorisation layer. All existing middleware (`config-verifier`, `domain-hash-auth`, `admin-superuser`, access-token verification) stays as-is.
- No per-tenant Postgres roles. The number of tenants is unbounded; we use session settings instead.
- No dynamic policy generation. Policies are static SQL checked into a migration.
- No attempt to enforce custom-role permissions (e.g. `team_role = 'admin'`) in SQL — that stays in the app.

## 3. Threat model

| Threat | How RLS helps |
|---|---|
| Service author forgets `org_id` in a Prisma `where` | Policy rejects rows outside `current_setting('app.org_id')` |
| Raw SQL (`$queryRaw`) leaks rows | Policy applies uniformly |
| Compromised app role with no BYPASSRLS | Cannot read other tenants even via arbitrary SQL |
| Superuser / admin operations | Run on a separate BYPASSRLS connection — RLS out of the way on purpose |
| Unauthenticated partner endpoints (JWKS, auto-discovery, claim) | Covered by permissive or predicate-bound policies so they still work without tenant context |

## 4. Roles

Three Postgres roles. All created by the first migration.

| Role | BYPASSRLS | Used by | Connection env var |
|---|---|---|---|
| `uoa_migrator` | yes | `prisma migrate deploy` in CI/CD only | `DATABASE_MIGRATE_URL` |
| `uoa_app` | **no** | Request handlers that run **after** tenant context is established | `DATABASE_URL` |
| `uoa_admin` | yes | Every DB access path that runs without tenant context | `DATABASE_ADMIN_URL` |

`uoa_admin` is a **bootstrap / maintenance** role, not just an admin-routes role. It is used by:

- Superuser admin routes (`/internal/admin/*`) and the writes they issue (including `admin_audit_log`).
- The entire auto-onboarding path on `/auth`: `findOpenIntegrationRequest`, the pending insert/update, the accept transaction, the resend-claim flow.
- The public claim flow (`/integrations/claim/:token` and its confirm). Rationale: the alternative — a permissive token-hash policy — still needs session-var plumbing on an unauthenticated route and does not materially improve the threat model beyond what the capability token already provides.
- Pre-context middleware reads: `domain-hash-auth.ts` resolving `client_domains` + active `client_domain_secrets`; `admin-superuser.ts` resolving `domain_roles`; `config-verifier.ts` resolving a JWK (with its related `client_domains` row) before any session var is set.
- `GET /.well-known/jwks.json` (unauthenticated JWKS union).
- `handshake_error_logs` writes from `config-verifier` failure paths (fired before the caller's domain is verified).
- Background jobs: `retention-pruning.service.ts` driven by the `app.ts` interval (`API/src/app.ts:96-112`), which runs with no request context.

Every other request (post-config-verifier, post-access-token) uses `uoa_app` and must satisfy the policies in section 7.

Net effect: policies are simple (no `OR is_superuser` branches), the bootstrap surface is explicit and listed, and the two roles correspond cleanly to "have tenant context" vs "do not have tenant context."

## 5. Session variables

All policies key off three settings, read with `current_setting(name, true)` so missing values return `NULL` rather than erroring:

| Setting | Source | Example |
|---|---|---|
| `app.domain` | `request.config.domain` after config verifier runs | `app.example.com` |
| `app.org_id` | `request.config.org_id` or from resolved org context | `ckx123...` |
| `app.user_id` | verified access-token claim | `ckv456...` |

Policies treat `NULL` as "no tenant" and deny. Admin role has BYPASSRLS so these settings are irrelevant on that connection.

## 6. Per-request context: `withTenantContext` helper

The per-query `$allOperations` extension approach does not work cleanly with this codebase: ~25 services already use interactive `prisma.$transaction(async tx => ...)` (e.g. `organisation.service.organisation.ts:83`, `integration-accept.service.ts:83`, `integration-claim.service.ts:150`). A per-query wrapper would either (a) open a fresh transaction per query, ignoring the enclosing user transaction, or (b) try to nest, which Prisma rejects on the main client.

Instead, the context is set **once per request, on the same interactive transaction the request handler runs inside**:

1. Two Fastify plugins register Prisma clients:
   - `request.db` → `uoa_app` client, lazily attached.
   - `request.adminDb` → `uoa_admin` client (no wrapping, no session vars — BYPASSRLS).
2. A Fastify `preHandler` that runs after `config-verifier` populates `request.tenantContext = { domain, orgId?, userId? }`. Middleware-stage DB reads (`domain-hash-auth`, `admin-superuser`, pre-context `config-verifier` JWK lookup) must use `request.adminDb`, not `request.db`.
3. Route handlers that touch `request.db` wrap their body in `runWithTenantContext(request, async (tx) => { ... })`. That helper:
   - Opens one interactive transaction on the `uoa_app` client.
   - Issues `SELECT set_config('app.domain', $1, true), set_config('app.org_id', $2, true), set_config('app.user_id', $3, true)` with values from `request.tenantContext`.
   - Passes `tx` to the handler. The handler threads `tx` to services (services already accept `deps.prisma`, so this is a plumbing change, not a signature change).
   - Commits or rolls back at the end of the handler.
4. Nested `prisma.$transaction(async innerTx => ...)` inside services is invoked on `tx` (the outer transactional client). Prisma turns nested interactive transactions into savepoints natively — GUCs stay in scope, rollback semantics are correct.

`set_config(..., true)` scopes the setting to the transaction, which is safe under any pooling mode (PgBouncer transaction, Cloud SQL proxy, direct connections). No pooler config change required.

App-layer services that currently call `getPrisma()` directly must be updated to take a prisma client from their caller. Grep shows this affects at least `audit-log.service.ts`, `access-request.service.auth.ts`, and a handful of others — the change is one param addition; no signature revolution.

Routes that touch `request.adminDb` do not run under `runWithTenantContext`. Examples: every `/internal/admin/*` route, the `/auth` auto-onboarding code path, `/integrations/claim/*`, `/.well-known/jwks.json`, and the retention-pruning timer.

## 7. Table-by-table classification

Legend: **T** = tenant-scoped by `org_id`, **D** = domain-scoped by `domain`, **U** = user-scoped by `user_id`, **P** = permissive (structural policy), **X** = excluded from RLS, **A** = admin-only (via `uoa_admin`).

### Tenant-scoped (org_id predicate)

| Table | Predicate |
|---|---|
| `organisations` | `id = current_setting('app.org_id', true)` OR `owner_id = current_setting('app.user_id', true)` OR (`domain = current_setting('app.domain', true)` AND `EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = organisations.id AND om.user_id = current_setting('app.user_id', true))`) — third branch is the bootstrap predicate used by `/org/organisations` list, `/org/me` resolution, and token-issuance org lookup, where `app.org_id` is not yet known |
| `org_members` | `org_id = current_setting('app.org_id', true)` |
| `teams` | `org_id = current_setting('app.org_id', true)` |
| `team_members` | `EXISTS (SELECT 1 FROM teams t WHERE t.id = team_members.team_id AND t.org_id = current_setting('app.org_id', true))` |
| `team_invites` | `org_id = current_setting('app.org_id', true)` |
| `groups` | `org_id = current_setting('app.org_id', true)` |
| `group_members` | `EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.org_id = current_setting('app.org_id', true))` |
| `access_requests` | `org_id = current_setting('app.org_id', true)` |

Each table gets one policy per command (`FOR SELECT`, `FOR INSERT`, `FOR UPDATE`, `FOR DELETE`) so that an `UPDATE` or `INSERT` cannot land a row into a foreign tenant. Insert policies use `WITH CHECK` on the same predicate. Update policies use both `USING` and `WITH CHECK` to block tenant-id swapping.

### Domain-scoped (domain predicate)

| Table | Predicate |
|---|---|
| `users` | `domain IS NULL OR domain = current_setting('app.domain', true)` — deliberate: `user_scope = global` stores users with `domain = NULL` and they must be visible from any domain context. This is a known weakening relative to strict domain isolation; documented, not a bug. Per-domain-only installs should set `user_scope = per_domain` (brief §3). |
| `verification_tokens` | `domain IS NULL OR domain = current_setting('app.domain', true)` |
| `authorization_codes` | `domain = current_setting('app.domain', true)` |
| `refresh_tokens` | `domain = current_setting('app.domain', true)` |
| `login_logs` | `domain = current_setting('app.domain', true)` |
| `domain_roles` | `domain = current_setting('app.domain', true)` — **but** `admin-superuser.ts` reads this table before any session var is set; that middleware uses `uoa_admin`. Policy exists as defense-in-depth for any future post-context read. |

`client_domains` and `client_domain_secrets` are **not** classified as app-role domain-scoped. Domain-hash auth reads them before `app.domain` is established (they are part of establishing it), and the config verifier's JWK lookup joins `client_domains` from a pre-context point. Both tables are accessed exclusively through `uoa_admin` (bootstrap client). They have RLS enabled with a deny-all policy for `uoa_app`, as belt-and-braces.

`handshake_error_logs` is **not** classified as app-role domain-scoped for the same reason: writes happen from `config-verifier` failure paths (`API/src/middleware/config-verifier.ts:165, 208, 242, 456-459`) before the caller's domain is verified. Writes go through `uoa_admin`. App-role reads are not a use case.

### Admin-only (auto-onboarding + audit tables)

All four auto-onboarding tables plus the audit log are accessed exclusively through `uoa_admin`. The initial draft proposed permissive policies for some of these, but code inspection showed that the paths need more than the permitted operations (e.g. `findOpenIntegrationRequest` → `findFirst` before `INSERT`; claim flow → `findFirst` + `UPDATE`). Pushing policies into those paths would require more session vars and more policy surface for no practical gain: these routes are unauthenticated by design and the capability enforcement lives in the token hash and request validation, not in RLS.

| Table | Strategy |
|---|---|
| `client_domain_jwks` | `uoa_admin` only. Used by `/.well-known/jwks.json` and by config-verifier kid lookup. `REVOKE ALL` for `uoa_app`. |
| `client_domain_integration_requests` | `uoa_admin` only. Auto-onboarding service (`integration-request.service.ts`, `auto-onboarding.service.ts`) receives the admin client from its caller. `REVOKE ALL` for `uoa_app`. |
| `integration_claim_tokens` | `uoa_admin` only. `REVOKE ALL` for `uoa_app`. |
| `admin_audit_log` | `uoa_admin` only. `REVOKE ALL` for `uoa_app`. `audit-log.service.ts` must be refactored to accept a prisma client from the caller instead of calling `getPrisma()` (current implementation binds it to `uoa_app`, which will permission-deny). |

No `app.claim_token_hash` session variable is needed — the claim route runs on `uoa_admin`.

### Excluded from RLS

| Table | Reason |
|---|---|
| `ai_translations` | Global cache, no tenancy. |
| `_prisma_migrations` | Managed by Prisma; leave alone. |

## 8. Migration plan

Two migrations. Splitting avoids the `FORCE ROW LEVEL SECURITY` baking-in risk that Codex flagged: once the first draft's single migration ran, RLS was live regardless of the `RLS_ENFORCED` flag.

### M1 — `enable_rls_roles_and_grants` (safe to ship independently)

1. Create roles if not exist: `uoa_migrator`, `uoa_app`, `uoa_admin`. Grant `CONNECT` on the database, `USAGE` on the schema.
2. `ALTER TABLE ... OWNER TO uoa_migrator` for every table.
3. Grant table/sequence privileges:
   - `uoa_app`: `SELECT, INSERT, UPDATE, DELETE` on tenant-scoped and domain-scoped tables.
   - `uoa_admin`: `SELECT, INSERT, UPDATE, DELETE` on every table listed in section 7, including admin-only.
   - `REVOKE ALL` on admin-only tables (`client_domain_jwks`, `client_domain_integration_requests`, `integration_claim_tokens`, `admin_audit_log`, `client_domains`, `client_domain_secrets`, `handshake_error_logs`) from `uoa_app`.
4. Do **not** `ENABLE ROW LEVEL SECURITY` yet. No policies yet. Shipping this migration is a no-op for runtime behaviour as long as the app keeps using the legacy connection URL; once the app switches to `uoa_app`, it can still read/write everything that wasn't revoked.

At this point, deploy the app with:

- `DATABASE_URL` → `uoa_app`
- `DATABASE_ADMIN_URL` → `uoa_admin`
- All bootstrap/admin code paths (section 4) switched to `request.adminDb`.
- `runWithTenantContext` helper in place on `uoa_app` code paths, issuing `set_config` even though no policies enforce it yet.

Soak in staging for at least 24 hours. Every route that breaks here surfaces as a plain Postgres permission error (from the REVOKEs) or a Prisma error from a missing admin-client wire-up. Fix forward without touching the migration.

### M2 — `enable_rls_policies` (the flip)

1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY; ALTER TABLE ... FORCE ROW LEVEL SECURITY;` on every table listed in section 7. `FORCE` is required because `uoa_migrator` owns the tables and would otherwise bypass RLS during future migrations.
2. `CREATE POLICY` per table per command, per section 7.
3. Admin-only tables get a deny-all policy (`USING (false) WITH CHECK (false)`) for `uoa_app`. Combined with the REVOKEs from M1 this is belt-and-braces.

Run M2 in staging first; soak again. Then run in prod.

Rollback: M2 can be reverted by `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` and `DROP POLICY` for every policy. Reversible.

No `RLS_ENFORCED` flag in the app. The two-migration split makes the flag unnecessary: M1 covers the plumbing, M2 is the atomic flip.

## 9. Interaction with auto-onboarding (chunks 1–7)

Chunks 1–4 are already on `feature/auto-onboarding`. Chunks 5–7 are still open. RLS lands **after** auto-onboarding fully merges to `main`.

All five auto-onboarding DB touch points run on `uoa_admin`:

- **`/.well-known/jwks.json` (chunk 2):** uses `request.adminDb`.
- **Config-verifier kid lookup (chunk 2):** `client-jwk.service.ts` is passed the admin client from `config-verifier` since this runs pre-context.
- **`/auth` auto-discovery (chunk 3):** `integration-request.service.ts` and `auto-onboarding.service.ts` accept a prisma client from their caller; the `/auth` route passes `request.adminDb` for this branch.
- **Admin API (chunk 4):** routes already guarded by `requireAdminSuperuser`; they switch to `request.adminDb`. `audit-log.service.ts` must be refactored to accept a prisma client parameter.
- **Claim flow (chunk 5, not yet merged):** implement with `request.adminDb` from day one. Do not add a `app.claim_token_hash` session var.

No chunk needs to be rewritten. The app-side changes are:

- Swap `getPrisma()` → `request.adminDb` in the five services/routes above.
- Refactor `audit-log.service.ts` to accept a prisma client from the caller.
- Add the Fastify plugins (section 6) and the `runWithTenantContext` helper.

## 10. Sharp edges

1. **Nested interactive `$transaction` is the real risk**, not array form. Existing services use `prisma.$transaction(async tx => ...)` at ~25 sites. The design in section 6 runs the entire request inside one interactive transaction, and those nested calls become savepoints on the outer tx — Prisma handles this natively in v5+. Do **not** use the per-query `$allOperations` wrapper pattern: it opens a fresh transaction per operation and loses session vars inside user-owned transactions.
2. **`audit-log.service.ts` currently calls `getPrisma()` directly** (`API/src/services/audit-log.service.ts:18-19, 31`). That binds it to `uoa_app`, which will permission-deny on `admin_audit_log`. Refactor to accept a prisma client parameter before M2.
3. **Background retention jobs** (`API/src/app.ts:96-112` → `retention-pruning.service.ts`) run with no request context and delete from domain-scoped tables. They must use `uoa_admin`; pass the admin client in at scheduler setup time.
4. **Cascade deletes** are evaluated with the parent row's visibility. If a user can see their org, cascading delete of `team_members` proceeds regardless of team-level policies. Acceptable — cascades are app-intended.
5. **`prepare` plan caching**: `current_setting()` is re-evaluated per execution, so prepared statements still respect changing session values. Confirmed in Postgres 14+.
6. **Tests that bypass Fastify** (unit tests instantiating services directly) must either inject a prisma client that is already inside a `withTenantContext` tx, or use the admin client.
7. **`_prisma_migrations`** must stay owned by `uoa_migrator` and never have RLS enabled.
8. **`ai_translations`** stays as-is; left out of the migration entirely.
9. **`FORCE ROW LEVEL SECURITY`** — critical because `uoa_migrator` owns the tables; without FORCE, any Prisma migration would bypass policies, which would mask policy bugs until the next schema change.
10. **Connection pool size**: each `uoa_app` request holds an interactive transaction for its whole duration. Current Prisma default is 2 × num_cpus; may need bumping. Benchmark before M2.
11. **Org bootstrap reads**: three code paths look up orgs before `app.org_id` is set — `/org/organisations` list by domain, `/org/me` resolve by user+domain, token issuance org resolution. Covered by the third branch of the `organisations` policy in section 7 (domain + membership). Same logic must not be generalised to `teams` / `groups` without an explicit reason; those always have `app.org_id` by the time they are queried.
12. **Global-scope users are not RLS-isolated** by domain. `User.domain IS NULL` rows are visible under any `app.domain`. This follows the `user_scope = global` product model; documented, not a bug. Per-domain installs pin users with a non-null `domain` and get strict isolation.

## 11. Rollout checklist

Prereqs:

- [ ] Auto-onboarding chunks 5–7 merged to `main`.
- [ ] `audit-log.service.ts` refactored to accept a prisma client parameter.
- [ ] Retention pruning refactored to accept a prisma client parameter.
- [ ] Other `getPrisma()` call sites in services audited and switched to injected-client pattern.

M1 (plumbing, reversible, no behaviour change if kept internal):

- [ ] M1 migration authored and code-reviewed.
- [ ] Env vars (`DATABASE_URL`, `DATABASE_ADMIN_URL`, `DATABASE_MIGRATE_URL`) wired in Cloud Run and local `.env.example`.
- [ ] `uoa_migrator`, `uoa_app`, `uoa_admin` exist in dev/staging/prod with the right privileges.
- [ ] Fastify plugins for `request.db` / `request.adminDb`, `tenantContext` preHandler, and `runWithTenantContext` helper landed.
- [ ] Admin/bootstrap code paths switched to `request.adminDb` (listed in section 4).
- [ ] Run M1 in staging. Smoke-test every public and admin route.

Integration testing (before M2):

- [ ] Two orgs in one domain: assert org A context cannot see, update, or insert into org B rows via `uoa_app`.
- [ ] Two domains: assert domain A context cannot see domain B `login_logs`, `refresh_tokens`, `authorization_codes`.
- [ ] Org bootstrap: `/org/organisations` and `/org/me` return the caller's orgs when `app.org_id` is not set.
- [ ] Auto-onboarding: `/auth` insert, re-attempt update, declined read all pass on `uoa_admin`.
- [ ] Admin middleware: `domain_roles` lookup succeeds on `uoa_admin`.
- [ ] Config-verifier JWK lookup with `client_domains` relation succeeds on `uoa_admin`.
- [ ] Retention pruning deletes expected rows without permission errors.
- [ ] All integration tests use a real Postgres — no mocks.

M2 (the flip):

- [ ] M2 migration authored and code-reviewed.
- [ ] Run M2 in staging. Soak ≥ 24h with production-like traffic patterns.
- [ ] Monitor for `new row violates row-level security policy` and `permission denied` in logs.
- [ ] Run M2 in prod.
- [ ] 72h post-deploy watch.

## 12. What we do not build here

- No SCIM-specific policies (SCIM is deferred per brief).
- No per-team policies (team is a child of org; org-level policy suffices for defense-in-depth).
- No custom-role enforcement in SQL.
- No row-level column masking.
- No audit-log policy for non-admin readers (admin-only table).

## 13. References

- `Docs/brief.md` — overall product model and org tenancy.
- `Docs/Requirements/roles-and-acl.md` — role semantics and superuser boundary.
- `Docs/Requirements/auto-onboarding.md` — feature whose tables live on `uoa_admin`.
- `Docs/Auth/architecture-api.md` — API layering; Prisma sits at the service layer.
- `API/prisma/schema.prisma` — canonical table list and FKs used to derive predicates.

## 14. Appendix A — DB access path → client map

Exhaustive map of every DB access path the reviews surfaced, grouped by required client. Anything not listed uses `request.db` (`uoa_app`) after `runWithTenantContext` has set session vars.

| Path | Client | Reason |
|---|---|---|
| `domain-hash-auth.ts` → `client_domains`, `client_domain_secrets` lookup | `uoa_admin` | Middleware runs pre-context (it IS the context-setter for domain). |
| `admin-superuser.ts` → `domain_roles` read | `uoa_admin` | Admin middleware runs before any session var. |
| `config-verifier.ts` → `client-jwk.service.ts` kid lookup (with `client_domains` relation) | `uoa_admin` | Runs before caller's domain is verified. |
| `config-verifier.ts` → `handshake-error-log.service.ts` write | `uoa_admin` | Failure paths fire before domain is verified. |
| `/auth` auto-discovery: `integration-request.service.ts`, `auto-onboarding.service.ts` | `uoa_admin` | Unauthenticated partner, no tenant context. |
| `/internal/admin/*` routes + their services | `uoa_admin` | Superuser scope, by design. |
| `/integrations/claim/:token` + confirm | `uoa_admin` | Capability token in URL; no tenant context. |
| `/.well-known/jwks.json` | `uoa_admin` | Unauthenticated. |
| Retention pruning timer (`app.ts:96-112` → `retention-pruning.service.ts`) | `uoa_admin` | Timer-driven, no request context. |
| `audit-log.service.ts` writes | `uoa_admin` | Called from admin routes; service must accept client param. |
| Post-auth org/team/group/member queries | `uoa_app` | Full context set by preHandler. |
| Post-auth user/token/login_log queries | `uoa_app` | Domain context set by preHandler. |
| `/org/organisations` list by domain | `uoa_app` | Uses organisations bootstrap predicate (domain + membership). |
| `/org/me` org resolution by user + domain | `uoa_app` | Same bootstrap predicate. |
| Token issuance org lookup (`token.service.ts:335`) | `uoa_app` | Same bootstrap predicate. |

## 15. Changelog

- **v0.1 — 2026-04-22** — initial draft.
- **v0.2 — 2026-04-22** — revised after parallel Claude and Codex reviews. Major changes: `uoa_admin` broadened to a bootstrap role (not just admin routes); all auto-onboarding tables moved to admin-only (no permissive policies); `organisations` predicate gained a domain+membership bootstrap branch; `handshake_error_logs`, `client_domains`, `client_domain_secrets` reclassified as admin-only; single migration split into M1 (plumbing) + M2 (flip); `RLS_ENFORCED` feature flag dropped; per-query `$allOperations` wrapper replaced by `runWithTenantContext` around the request handler body; appendix A added.
