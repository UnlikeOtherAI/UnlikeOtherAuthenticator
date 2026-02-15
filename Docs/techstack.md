# Tech Stack & Project Structure

This document defines the technology choices and project structure for the OAuth & Auth Service.

For the full product specification, see [brief.md](./brief.md).

---

## Runtime & Language

* **Node.js** — server runtime for the API
* **JavaScript/TypeScript** — all code in the project

---

## API (`/API`)

The API is the central OAuth/auth server. It handles:

* Config JWT fetching and verification
* User registration, login, and password management
* Social OAuth provider callbacks
* Authorization code generation and token exchange
* 2FA setup and verification
* Domain-scoped APIs (user list, login logs, debug)
* Organisation, team, and group management APIs (`/org/*` and `/internal/org/*`)
* Email dispatch (verification, password reset, login links)

### Structure

```
/API
  /routes          — Express/Fastify route handlers
  /routes/org      — User-facing org/team routes
  /routes/internal/org — Internal org-team-group admin routes
  /middleware       — Auth, config verification, error handling
  /models          — Database models (users, domain roles, login logs, tokens)
  /services        — Business logic (auth, email, JWT, TOTP, social providers)
  /utils           — Shared helpers (hashing, validation, generic errors)
  /migrations      — Database schema migrations
  /config          — Environment loading, constants
```

### Key Decisions

* RESTful, stateless endpoints
* JWT for both config verification and access tokens (separate concerns, separate validation)
* Shared secret loaded from environment variables only
* All error responses are generic to the user — specifics in internal logs only
* Organisational models: `organisations`, `org_members`, `teams`, `team_members`, `groups`, `group_members`

### Organisational Endpoints

* `POST /org/organisations` — create an organisation (also creates default team)
* `GET /org/organisations` — list organisations on a domain
* `GET /org/organisations/:orgId` — read org details
* `PUT /org/organisations/:orgId` — update org metadata
* `DELETE /org/organisations/:orgId` — delete org and nested data
* `GET /org/organisations/:orgId/members` — list org members
* `POST /org/organisations/:orgId/members` — add org member
* `PUT /org/organisations/:orgId/members/:userId` — change org role
* `DELETE /org/organisations/:orgId/members/:userId` — remove org member
* `POST /org/organisations/:orgId/transfer-ownership` — transfer org ownership
* `GET /org/organisations/:orgId/teams` — list teams
* `POST /org/organisations/:orgId/teams` — create team
* `GET /org/organisations/:orgId/teams/:teamId` — read team details
* `PUT /org/organisations/:orgId/teams/:teamId` — update team
* `DELETE /org/organisations/:orgId/teams/:teamId` — delete team
* `POST /org/organisations/:orgId/teams/:teamId/members` — add team member
* `PUT /org/organisations/:orgId/teams/:teamId/members/:userId` — change team role
* `DELETE /org/organisations/:orgId/teams/:teamId/members/:userId` — remove team member
* `GET /org/organisations/:orgId/groups` — list groups
* `GET /org/organisations/:orgId/groups/:groupId` — read group details
* `GET /org/me` — current user org context

### Internal API

* `POST /internal/org/organisations/:orgId/groups` — create group
* `PUT /internal/org/organisations/:orgId/groups/:groupId` — update group
* `DELETE /internal/org/organisations/:orgId/groups/:groupId` — delete group
* `POST /internal/org/organisations/:orgId/groups/:groupId/members` — add group member
* `PUT /internal/org/organisations/:orgId/groups/:groupId/members/:userId` — toggle `is_admin`
* `DELETE /internal/org/organisations/:orgId/groups/:groupId/members/:userId` — remove group member
* `PUT /internal/org/organisations/:orgId/teams/:teamId/group` — assign/unassign team

---

## Auth Window (`/Auth`)

The auth window is the user-facing UI rendered inside the OAuth popup. It is a **React** application.

* **All frontend files are React** — no other UI frameworks
* **Tailwind CSS** — the only CSS framework allowed
* All theming is config-driven — no hardcoded client styles

### Structure

```
/Auth
  /src
    /components    — React components (forms, buttons, cards, layout)
    /pages         — Login, Register, Password Reset, 2FA Setup, 2FA Verify
    /theme         — Theme engine (reads config, generates Tailwind classes)
    /i18n          — Translation loader, language selector, AI fallback integration
    /hooks         — React hooks (auth state, config, theme)
    /utils         — Frontend helpers
  /public          — Static assets (minimal)
```

### Key Decisions

* Server-side rendered where needed for the initial auth UI load
* Theme properties (colors, radii, typography, logo, density) all sourced from config JWT
* Language selector only shown when config provides multiple languages
* Popup communicates back to client via authorization code redirect, not postMessage

---

## Database

* **PostgreSQL** — the database
* **Prisma** — ORM and migration tool
* Tables: `users`, `domain_roles`, `login_logs`, `verification_tokens`
* Organisational tables: `organisations`, `org_members`, `teams`, `team_members`, `groups`, `group_members`
* All schema changes go through Prisma migrations — no manual SQL
* Prisma schema lives in `/API/prisma/schema.prisma`
* Superuser race condition resolved at DB constraint level (unique constraint, first insert wins)

---

## External Integrations

* **Social OAuth Providers** — Google, Apple, Facebook, GitHub, LinkedIn (one set of credentials for the auth service, not per-client)
* **Email Service** — provider-abstracted (e.g. SendGrid, SES), swappable without code changes
* **AI Translation Service** — for missing translation fallback, results cached permanently

---

## Environment Variables

All secrets and configuration live in environment variables. Nothing is hardcoded.

* `SHARED_SECRET` — the single global shared secret for JWT signing and domain hashing
* `AUTH_SERVICE_IDENTIFIER` — auth service identifier (expected `aud` for config JWTs)
* `DATABASE_URL` — database connection string
* Social provider credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, etc.)
* Email service credentials:
  * `EMAIL_PROVIDER` — `disabled` (default behavior) or `smtp`
  * `EMAIL_FROM` — required for `smtp`
  * `EMAIL_REPLY_TO` — optional reply-to address
  * `SMTP_HOST` — required for `smtp`
  * `SMTP_PORT` — optional (default: 587)
  * `SMTP_SECURE` — optional (`true`/`false`, default: `false`)
  * `SMTP_USER` / `SMTP_PASSWORD` — optional (SMTP auth)
* AI translation service credentials
* `ACCESS_TOKEN_TTL` — access token lifetime (minutes-only, 15m–60m; default: 30m)
* `LOG_RETENTION_DAYS` — login log retention window (default: 90)
