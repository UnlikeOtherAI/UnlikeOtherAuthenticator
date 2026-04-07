# API Architecture

This document defines the internal architecture for the `/API` directory — the central OAuth/auth server.

For the full product spec, see [brief.md](./brief.md). For tech stack, see [techstack.md](./techstack.md).

---

## Guiding Principles

* **No code file longer than 500 lines.** If a file approaches this limit, split it.
* **One responsibility per file.** A route file handles routing. A service file handles logic. They don't mix.
* **Thin routes, fat services.** Route handlers validate input, call a service, and return a response. Business logic lives in services.
* **Flat over nested.** Prefer shallow directory structures. Avoid deeply nested folders.
* **Explicit over clever.** Straightforward code beats abstractions. No magic.

---

## Directory Structure

```
/API
  /src
    /routes
      /root
        index.ts              — GET / (full endpoint schema)
        llm.ts                — GET /llm (config documentation for LLM consumers)
      /apps
        apps.ts               — CRUD for /org/:orgId/apps[/:appId]
        killswitches.ts       — CRUD for /org/:orgId/apps/:appId/killswitches[/:id]
        flags.ts              — Flag definitions: GET/POST/PATCH/DELETE /org/:orgId/apps/:appId/flags/definitions[/:flagKey]
        flag-matrix.ts        — GET/PATCH /org/:orgId/apps/:appId/flags/matrix[/:roleName/:flagKey]
        flag-overrides.ts     — GET/PUT/DELETE /org/:orgId/apps/:appId/flags/overrides/:userId[/:flagKey]
        flag-query.ts         — GET /apps/:appId/flags (resolved flag map for a user; domain-hash auth, no orgId in path)
        startup.ts            — GET /apps/startup (combined kill switch + flags; public)
        killswitch-check.ts   — GET /killswitch/check (standalone kill switch query; public)
        index.ts              — Route registration for /apps and /killswitch
      /auth
        login.ts              — POST /auth/login
        register.ts           — POST /auth/register
        verify-email.ts       — POST /auth/verify-email
        reset-password.ts     — POST /auth/reset-password
        callback.ts           — GET  /auth/callback/:provider
        social.ts             — GET /auth/social/:provider
        token-exchange.ts     — POST /auth/token
        revoke.ts             — POST /auth/revoke
        entrypoint.ts         — GET /auth (main auth entry)
        email-reset-password.ts  — GET /auth/email-reset-password
        email-registration-link.ts — GET /auth/email-registration-link
        email-twofa-reset.ts  — GET /auth/email-twofa-reset
        index.ts              — Route registration for /auth
      /i18n
        get.ts                — GET /i18n/:language
        index.ts              — Route registration for /i18n
      /twofactor
        verify.ts             — POST /2fa/verify
        reset.ts              — POST /2fa/reset
        index.ts              — Route registration for /2fa
      /domain
        users.ts              — GET  /domain/users
        logs.ts               — GET  /domain/logs
        debug.ts              — GET  /domain/debug
        index.ts              — Route registration for /domain
      /org
        organisations.ts      — Organisations + memberships + ownership transfer
        teams.ts              — Teams + team membership operations + custom role CRUD (/org/:orgId/teams/:teamId/roles)
        domain-rules.ts       — GET/POST/DELETE /org/:orgId/domain-rules (email domain auto-enrolment rules)
        groups.ts             — GET group operations (org-aware reads)
        me.ts                 — GET /org/me
        index.ts              — Route registration for /org
      /health
        index.ts              — GET  /health
      /internal
        /org
          groups.ts              — POST/PUT/DELETE internal group operations
          group-members.ts       — POST/PUT/DELETE internal group members
          team-group-assignment.ts — PUT team↔group assignment
          index.ts               — Route registration for /internal/org
        /admin
          orgs.ts                — GET /internal/admin/orgs, GET /internal/admin/orgs/:orgId
          org-members.ts         — PATCH/DELETE /internal/admin/orgs/:orgId/members/:userId
          org-domain-rules.ts    — GET/POST/DELETE /internal/admin/orgs/:orgId/domain-rules
          team-members.ts        — PATCH /internal/admin/teams/:teamId/members/:userId
          scim-tokens.ts         — GET/POST/DELETE /internal/admin/orgs/:orgId/scim-tokens  [DEFERRED]
          scim-group-mappings.ts — GET/POST/DELETE /internal/admin/orgs/:orgId/scim/group-mappings  [DEFERRED]
          index.ts               — Route registration for /internal/admin
      /scim                      [DEFERRED — full spec in roles-and-acl.md; schema ready]
        users.ts               — POST/GET/PATCH/DELETE /scim/v2/Users[/:id]
        groups.ts              — GET/POST/PATCH/DELETE /scim/v2/Groups[/:id]
        index.ts               — Route registration for /scim/v2 (uses ScimToken bearer auth, no config-verifier)
    /middleware
      config-verifier.ts      — Fetches config URL, verifies JWT, attaches config to request
      domain-hash-auth.ts     — Verifies domain hash token for domain-scoped APIs
      superuser-access-token.ts — Verifies user access token and requires superuser role
      org-features.ts         — Returns 404 when org features are disabled
      groups-enabled.ts       — Returns 404 when groups are disabled
      org-role-guard.ts       — Validates user access token and org role for /org endpoints
      org-permission.ts       — requireOrgRole(minRole) — org-level UOA role enforcement (owner > admin > member)
      team-permission.ts      — requireTeamRole(minRole) — team-level UOA role enforcement with org-level fallback
      scim-auth.ts            — SCIM bearer token validation and org-scope verification for /scim/v2/* routes  [DEFERRED]
      error-handler.ts        — Global error handler (generic user-facing errors, detailed internal logs)
      rate-limiter.ts         — Rate limiting
    /services
      auth.service.ts         — Login, registration, password verification logic
      config.service.ts       — Config JWT fetching, parsing, validation
      token.service.ts        — Access token, refresh token, and authorization code orchestration
      refresh-token.service.ts — Refresh token issuance, rotation, reuse detection, revocation
      organisation.service.ts  — Organisation orchestration API
      organisation.service.base.ts — Organisation service building blocks
      organisation.service.organisation.ts — Organisation CRUD + slug generation
      organisation.service.members.ts — Org membership lifecycle
      team.service.ts         — Team orchestration API
      team.service.base.ts    — Team service building blocks
      team.service.teams.ts   — Team CRUD
      team.service.members.ts — Team member lifecycle
      group.service.ts        — Group orchestration API
      group.service.base.ts   — Group service building blocks
      group.service.groups.ts — Group CRUD
      group.service.members.ts — Group membership lifecycle
      org-context.service.ts  — Resolve user org context for JWT enrichment and /org/me
      password.service.ts     — Hashing, validation rules, comparison
      email.service.ts        — Email dispatch abstraction (verification, reset, login links)
      social
        google.service.ts     — Google OAuth flow
        apple.service.ts      — Apple OAuth flow
        facebook.service.ts   — Facebook OAuth flow
        github.service.ts     — GitHub OAuth flow
        linkedin.service.ts   — LinkedIn OAuth flow
        microsoft.service.ts  — Microsoft Entra ID (Azure AD) OIDC flow
        provider.base.ts      — Shared interface and email verification enforcement
      totp.service.ts         — TOTP secret generation, QR code, verification
      user.service.ts         — User CRUD, scope handling (global vs per-domain)
      domain.service.ts       — Client ID generation, domain verification, superuser logic
      translation.service.ts  — AI translation fallback and caching
      app.service.ts          — App CRUD, identifier uniqueness, platform validation
      killswitch.service.ts   — Kill switch entry CRUD, version matching, priority resolution, activateAt scheduling
      flag.service.ts         — Flag definition CRUD, role matrix management, per-user override management, flag resolution
    /utils
      hash.ts                 — Hashing helpers (domain + secret, tokens)
      errors.ts               — Generic error factory (never leaks specifics)
      validation.ts           — Input validation helpers
      logger.ts               — Structured logging (internal details only)
    /config
      env.ts                  — Environment variable loading and validation
      constants.ts            — App-wide constants (token TTL defaults, retention defaults)
  /prisma
    schema.prisma             — Database schema
    /migrations               — Prisma migration files
  /tests
    /unit                     — Unit tests per service
    /integration              — API endpoint integration tests
  server.ts                   — Server entry point
  app.ts                      — Fastify app setup and middleware registration
```

---

## Layered Architecture

```
Request → Route → Middleware → Service → Database (Prisma)
                                ↓
                          External APIs
                     (social providers, email, AI)
```

### Routes (thin)

* Parse and validate request input
* Call the appropriate service
* Return the response
* No business logic
* Each route file handles one endpoint or a tight group of related endpoints

### Middleware

* **config-verifier** — runs on all OAuth entry points. Fetches config from URL, verifies JWT, attaches parsed config to the request context. **Bypass exceptions** (SDK-facing or machine-readable endpoints called without a backend config context): `GET /killswitch/check`, `GET /apps/startup`, `GET /` (schema), `GET /llm` (config docs). All `/scim/v2/*` endpoints also bypass config-verifier (they use SCIM bearer token auth instead) — noted here for when SCIM is implemented [DEFERRED].
* **domain-hash-auth** — runs on domain-scoped API routes. Verifies the domain hash token
* **superuser-access-token** — validates user access tokens for superuser-only domain endpoints
* **org-features** — rejects org endpoints when `org_features.enabled` is false
* **groups-enabled** — rejects group endpoints when `org_features.groups_enabled` is false
* **org-role-guard** — validates user context and org role for `/org/*` routes
* **org-permission** (`requireOrgRole(minRole)`) — enforces org-level UOA role (`owner > admin > member`). Reads `OrgMember.role` for the authenticated user in the target org. Returns 403 if not a member or role is insufficient. Used on org management endpoints and admin panel org routes. See `api-changes-rebac.md §4`.
* **team-permission** (`requireTeamRole(minRole)`) — enforces team-level UOA role with org-level fallback inheritance. Checks `TeamMember.role` first; if not a direct member, falls back to the user's `OrgMember.role` for the parent org. Returns 403 if neither check passes. See `api-changes-rebac.md §4`.
* **scim-auth** — [DEFERRED] used only on `/scim/v2/*` routes. Extracts the bearer token from the `Authorization` header, looks up the hashed token in `ScimToken`, validates the org scope. Returns 401 on missing/invalid token, 403 on org scope mismatch.
* **error-handler** — catches all errors. Returns generic message to user. Logs specifics internally

### Services (fat)

* All business logic lives here
* Services call Prisma for database access
* Services call other services when needed (e.g. auth service calls password service)
* Each service file covers one domain of logic
* Social providers each get their own file, sharing a common base interface

### Utils

* Pure helper functions with no side effects
* No database access
* No external API calls

---

## File Size Rules

* **Maximum 500 lines per code file.** No exceptions.
* If a service grows past this, split by sub-concern (e.g. `auth.service.ts` → `auth-login.service.ts` + `auth-register.service.ts`)
* If a route file grows past this, split by endpoint
* Tests have no line limit but should still be organized logically

---

## Error Handling

* All errors thrown internally use structured error objects with codes
* The global error handler catches everything
* User-facing responses are always generic: `"Authentication failed"`, `"Request failed"`, etc.
* Internal logs include the full error with stack trace, context, and specifics
* Never return: "wrong password", "email exists", "2FA failed", "wrong provider", or any other specific reason

---

## Database Access

* **Prisma only** — no raw SQL unless absolutely necessary
* All queries go through services, never directly from routes
* Transactions used where atomicity matters (e.g. user creation + superuser assignment)
* Connection pooling handled by Prisma

---

## Testing

* Unit tests for all services
* Integration tests for all API endpoints
* Tests verify generic error responses (no leakage)
* Tests verify enumeration protection
* Test files live alongside what they test or in `/tests`
