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
      /auth
        login.ts              — POST /auth/login
        register.ts           — POST /auth/register
        verify-email.ts       — POST /auth/verify-email
        reset-password.ts     — POST /auth/reset-password
        callback.ts           — GET  /auth/callback/:provider
        token-exchange.ts     — POST /auth/token
      /twofactor
        setup.ts              — POST /2fa/setup
        verify.ts             — POST /2fa/verify
        reset.ts              — POST /2fa/reset
      /domain
        users.ts              — GET  /domain/users
        logs.ts               — GET  /domain/logs
        debug.ts              — GET  /domain/debug
      /org
        organisations.ts      — POST/GET/PUT/DELETE organisation operations
        org-members.ts        — POST/DELETE org members + role transfers
        teams.ts              — POST/GET/PUT/DELETE team operations
        team-members.ts       — POST/DELETE team members
        groups.ts             — GET group operations (org-aware reads)
        me.ts                 — GET /org/me
      /health
        index.ts              — GET  /health
    /routes/internal
      /org
        groups.ts              — POST/PUT/DELETE internal group operations
        group-members.ts       — internal group member management
        team-group-assignment.ts — internal team to group assignment
    /middleware
      config-verifier.ts      — Fetches config URL, verifies JWT, attaches config to request
      domain-auth.ts          — Verifies domain hash token for domain-scoped APIs
      org-features.ts         — Returns 404 when org features are disabled
      groups-enabled.ts       — Returns 404 when groups are disabled
      org-role-guard.ts       — Validates user access token and org role for /org endpoints
      error-handler.ts        — Global error handler (generic user-facing errors, detailed internal logs)
      rate-limiter.ts         — Rate limiting
    /services
      auth.service.ts         — Login, registration, password verification logic
      config.service.ts       — Config JWT fetching, parsing, validation
      token.service.ts        — Access token and authorization code generation/verification
      organisation.service.ts  — Organisation CRUD and membership lifecycle
      team.service.ts         — Team CRUD and team membership lifecycle
      group.service.ts        — Group CRUD and membership lifecycle
      org-context.service.ts  — Resolve user org context for JWT enrichment
      password.service.ts     — Hashing, validation rules, comparison
      email.service.ts        — Email dispatch abstraction (verification, reset, login links)
      social
        google.service.ts     — Google OAuth flow
        apple.service.ts      — Apple OAuth flow
        facebook.service.ts   — Facebook OAuth flow
        github.service.ts     — GitHub OAuth flow
        linkedin.service.ts   — LinkedIn OAuth flow
        provider.base.ts      — Shared interface and email verification enforcement
      totp.service.ts         — TOTP secret generation, QR code, verification
      user.service.ts         — User CRUD, scope handling (global vs per-domain)
      domain.service.ts       — Client ID generation, domain verification, superuser logic
      translation.service.ts  — AI translation fallback and caching
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
  app.ts                      — Express/Fastify app setup and middleware registration
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

* **config-verifier** — runs on all OAuth entry points. Fetches config from URL, verifies JWT, attaches parsed config to the request context
* **domain-auth** — runs on domain-scoped API routes. Verifies the domain hash token
* **org-features** — rejects org endpoints when `org_features.enabled` is false
* **groups-enabled** — rejects group endpoints when `org_features.groups_enabled` is false
* **org-role-guard** — validates user context and org role for `/org/*` routes
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
