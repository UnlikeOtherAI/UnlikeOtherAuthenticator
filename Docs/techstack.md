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
* Email dispatch (verification, password reset, login links)

### Structure

```
/API
  /routes          — Express/Fastify route handlers
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
* Email service credentials
* AI translation service credentials
* `ACCESS_TOKEN_TTL` — access token lifetime (default: short-lived, e.g. 30m)
* `LOG_RETENTION_DAYS` — login log retention window (default: 90)
