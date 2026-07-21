# Tech Stack & Project Structure

This document defines the technology choices and project structure for the OAuth & Auth Service.

For the full product specification, see [brief.md](./brief.md).

---

## Runtime & Language

- **Node.js** — server runtime for the API
- **JavaScript/TypeScript** — all code in the project

---

## API (`/API`)

The API is the central OAuth/auth server. It handles:

- Config JWT fetching and verification
- User registration, login, and password management
- Social OAuth provider callbacks
- Authorization code generation and token exchange
- Confidential source-JWT and UOA access-token chaining into short-lived, resource-bound RS256 access tokens
- 2FA setup and verification
- Domain-scoped APIs (user list, login logs, debug)
- Organisation, team, and group management APIs (`/org/*` and `/internal/org/*`)
- Canonical product tariff catalog, org/team assignments, and signed entitlement snapshots
- Email dispatch (verification, password reset, login links)
- Optional per-domain agreement signatures, private PDF evidence, and signed receipts

### Structure

```
/API
  /src
    /routes          — Fastify route handlers
    /routes/org      — User-facing org/team routes
    /routes/internal — Internal admin routes (incl. /internal/org/*)
    /middleware      — Auth, config verification, error handling
    /models          — Reserved for domain types (currently empty)
    /services        — Business logic (auth, email, JWT, TOTP, social providers)
    /plugins         — Fastify plugins (Prisma, logging, etc.)
    /db              — Prisma client wiring
    /utils           — Shared helpers (hashing, validation, generic errors)
    /config          — Environment loading, constants
  /prisma            — Schema and database migrations
```

### Key Decisions

- RESTful, stateless endpoints
- JWT for both config verification and access tokens (separate concerns, separate validation)
- Shared secret loaded from environment variables only
- All error responses are generic to the user — specifics in internal logs only
- Organisational models: `organisations`, `org_members`, `teams`, `team_members`, `groups`, `group_members`
- Signature uploads use `@fastify/multipart`, `pdf-lib` for bounded parsing/receipt generation, ClamAV for malware scanning, private object storage, and a dedicated RS256 JWK via `jose`; evidence keys are never shared with config or token signing

### Organisational Endpoints

- `POST /org/organisations` — create an organisation (also creates default team)
- `GET /org/organisations` — list organisations on a domain
- `GET /org/organisations/:orgId` — read org details
- `PUT /org/organisations/:orgId` — update org metadata
- `DELETE /org/organisations/:orgId` — delete org and nested data
- `GET /org/organisations/:orgId/members` — list org members
- `POST /org/organisations/:orgId/members` — add org member
- `PUT /org/organisations/:orgId/members/:userId` — change org role
- `DELETE /org/organisations/:orgId/members/:userId` — remove org member
- `POST /org/organisations/:orgId/transfer-ownership` — transfer org ownership
- `GET /org/organisations/:orgId/teams` — list teams
- `POST /org/organisations/:orgId/teams` — create team
- `GET /org/organisations/:orgId/teams/:teamId` — read team details
- `PUT /org/organisations/:orgId/teams/:teamId` — update team
- `DELETE /org/organisations/:orgId/teams/:teamId` — delete team
- `POST /org/organisations/:orgId/teams/:teamId/members` — add team member
- `PUT /org/organisations/:orgId/teams/:teamId/members/:userId` — change team role
- `DELETE /org/organisations/:orgId/teams/:teamId/members/:userId` — remove team member
- `GET /org/organisations/:orgId/groups` — list groups
- `GET /org/organisations/:orgId/groups/:groupId` — read group details
- `GET /org/me` — current user org context

### Internal API

- `POST /internal/org/organisations/:orgId/groups` — create group
- `PUT /internal/org/organisations/:orgId/groups/:groupId` — update group
- `DELETE /internal/org/organisations/:orgId/groups/:groupId` — delete group
- `POST /internal/org/organisations/:orgId/groups/:groupId/members` — add group member
- `PUT /internal/org/organisations/:orgId/groups/:groupId/members/:userId` — toggle `is_admin`
- `DELETE /internal/org/organisations/:orgId/groups/:groupId/members/:userId` — remove group member
- `PUT /internal/org/organisations/:orgId/teams/:teamId/group` — assign/unassign team
- `/internal/admin/*` is the planned system-admin route family for the admin panel; see `Docs/Requirements/roles-and-acl.md` and `Docs/Admin/architecture-admin.md`

---

## Auth Window (`/Auth`)

The auth window is the user-facing UI rendered inside the OAuth popup. It is a **React** application.

- **All frontend files are React** — no other UI frameworks
- **Tailwind CSS** — the only CSS framework allowed
- All theming is config-driven — no hardcoded client styles

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

- Server-side rendered where needed for the initial auth UI load
- Theme properties (colors, radii, typography, logo, density) all sourced from config JWT
- Language selector only shown when config provides multiple languages
- Popup communicates back to client via authorization code redirect, not postMessage

---

## Admin Panel (`/Admin`)

The admin panel is a separate authenticated frontend application for UOA operators.

It should be implemented as a **React CSR** app, not SSR.
In production, the API service serves the built Admin app from `/admin` so it runs on the same origin as the auth API.
The API root `/` is a Tailwind holding page linking operators and integrators to `/admin`, `/llm`, and `/api`.

`Docs/Admin/architecture-admin.md` is the canonical admin architecture document.

### Existing Template Baseline

The admin panel templates already exist in [`Docs/Admin/README.md`](./Admin/README.md).

Do not rebuild the admin UI from scratch.

Use these existing template files as the visual and structural baseline:

- `Docs/Admin/template-login.html`
- `Docs/Admin/template-folder.html`
- `Docs/Admin/template-admin.html`

The React implementation should translate those templates into reusable components and route layouts.

### Recommended Stack

- **React** — frontend UI runtime
- **TypeScript** — required for all admin code
- **Vite** — frontend build tool
- **React Router** — client-side routing
- **Tailwind CSS** — the only styling system
- **TanStack Query** — server-state and cache management
- **native `fetch` via a shared client** — HTTP transport
- **react-hook-form + Zod** — form state and validation at the boundary
- **React Context** — small shared UI state only (selected org, shell state, user preferences). Do not add Zustand unless the state shape actually outgrows Context.
- **Vitest** — frontend unit/component test runner

### Key Decisions

- CSR only for authenticated admin workflows
- Architecture, module boundaries, forms, and auth rules live in `Docs/Admin/architecture-admin.md`
- No Prisma or backend-only models in frontend code
- The admin app must be under strict linting and strict TypeScript rules

### Environment and API Wiring

- The admin app must read its API base URL from Vite environment configuration, for example `VITE_API_BASE_URL`
- Do not hardcode hosts or protocols in components or services
- Keep API client creation centralized so headers, error mapping, and auth behavior are not duplicated

### Assets and Icons

- Reuse `/assets` for UOA-owned branding assets such as app icons, favicons, and admin brand marks
- For product UI action icons, use inline SVG components consistently rather than mixing icon sources

### Quality Gate

- `Admin` source files must be covered by ESLint
- Lint must fail the build on violations
- Strict TypeScript settings must remain enabled
- Components should remain small and composable
- Avoid `any`, dead exports, and page-local duplicated UI patterns

### Canonical Documentation Rule

- `Docs/Admin/README.md` is the canonical template-baseline document
- `Docs/Admin/architecture-admin.md` is the canonical admin architecture document
- `Docs/techstack.md` is the canonical admin stack and environment document
- Implementation plans should reference these documents rather than restating their rules in full

---

## Database

- **PostgreSQL** — the database
- **Prisma** — ORM and migration tool
- Tables: `users`, `domain_roles`, `login_logs`, `verification_tokens`, `confidential_assertion_uses`
- Confidential delegation policy: `confidential_delegation_mappings` binds an authenticated `client_domains` row + product to one exact HTTPS resource and an explicit `ai.invoke` / `billing.read` / `token.provision` allowlist. Every application-to-application hop authenticates with the immediate caller application's own credential and mapping. Chained UOA access tokens require the exact caller audience, narrow through the inbound token and both source/caller mappings, cannot outlive the inbound token, and preserve provenance in the `act` chain. Token provisioning is never implied by AI invocation. It is admin-only under forced RLS; there is no process-env fallback.
- Organisational tables: `organisations`, `org_members`, `teams`, `team_members`, `groups`, `group_members`
- Billing control-plane tables include `billing_services`, immutable tariffs and assignments, purpose-bound app keys, service access, commercial adjustments, Stripe account/customer/catalog/subscription/webhook projections, one exact-team shared credit account with append-only entries and settlement allocations, immutable superuser credit-adjustment evidence, top-up/auto-top-up consent and Stripe evidence, and versioned recurring add-on offers/subscriptions/cancellation intents. Commercial tables use forced RLS and deny the ordinary app role; exact invariants live in the Prisma migration rather than product code.
- Optional signature-module tables: `domain_signature_settings`, `agreements`, `agreement_versions`, `signing_continuations`, `agreement_signatures`, `signature_revocations`, `signature_audit_events`
- All schema changes go through Prisma migrations — no manual SQL
- Prisma schema lives in `/API/prisma/schema.prisma`
- Superuser race condition resolved at DB constraint level (unique constraint, first insert wins)

---

## External Integrations

- **Social OAuth Providers** — Google, Apple, Facebook, GitHub, LinkedIn, Microsoft (Entra ID / Azure AD OIDC) (one set of credentials for the auth service, not per-client)
- **Email Service** — provider-abstracted (e.g. SendGrid, SES), swappable without code changes
- **AI Translation Service** — for missing translation fallback, results cached permanently
- **Private Signature Object Storage** — disabled by default; private local filesystem in development/test and Google Cloud Storage via Application Default Credentials when explicitly configured
- **Ledger and Product Billing Clients** — server-to-server tariff reads use a distinct product- and purpose-bound UOA app key plus a credential-bound RS256 actor assertion; entitlement keys cannot call lifecycle routes, lifecycle keys cannot call effective-tariff, and every body product must match the bound service. Each product confirms its own direct session after UOA SSO through `/billing/v1/service-access/confirm`; proxy use never confirms another product. UOA returns signed content-free snapshots and never receives provider content. Pricing/rating and payment collection are independent signed tariff terms (`collection_mode = stripe | manual | none`)
- **Canonical UOA billing + Stripe Billing** — UOA is the commercial system of record. Product backends use their individual purpose-bound app key and a fresh actor JWT to fetch display-ready statements, shared credits, recurring add-ons, and customer actions; products never re-rate raw usage or invent totals, shares, wording, options, or cancellation choices. Frozen `BillingStatementV1` remains available, while `BillingStatementV2` adds UOA's complete team-wide connected-service, origin-product, and per-user portfolio. `BillingCreditsV1` adds the exact-team balance (`Remaining credits`), fixed 1,000 credits/US$1 conversion, fixed top-up offers, and bounded automatic top-up. Admin exposes the same display term in a cursor-paged, exact-search Team credits view with copyable stable account/org/team IDs and explicit test/live mode. Signed superuser repairs require a two-minute server preview bound to current/resulting credits and automatic-top-up configuration; preview and confirmation take the scheduler advisory lock before the account row lock, reject unresolved attempts, and confirmation revalidates the frozen values before append-only evidence plus the exact linked entry. No direct balance update or browser-side internal-unit conversion exists. Recurring add-ons cover organisation/team/subscribing-user scopes, including DeepWater's US$50/month privacy offer. The MIT-licensed `@unlikeotherai/billing-statement-protocol` workspace is the single TypeScript/JSON Schema/OpenAPI 3.1/fixture source and has no private server imports or secrets, so open-source products can pack or vendor it without coupling to UOA internals. Manager/member discriminated schemas prevent ordinary-member responses from containing arbitrary user identity, payment-instrument display data, or enabled money actions. Runtime product entitlements remain in UOA's per-App feature-flag service rather than being inferred from tariff keys. UOA pins Ledger's immutable product-scoped `metering-usage-v1` snapshots for commercial rating/Stripe export and exact-team `metering-portfolio-v1` snapshots for transparency and credit settlement. It centrally applies immutable tariffs and contract margins and owns subscriptions, scoped add-ons, shared credits, direct product-access evidence, invoices, and cancellation state. Contract invoice views expose customer price per service but never raw tokens, provider cost, markup, or margin calculations. Ledger contains no commercial fields. Stripe Billing is an optional payment processor disabled by default; every projection is scoped to the exact Stripe account and test/live mode. UOA→Ledger uses UOA's dedicated Ledger app key plus a separately signed `metering.read` service assertion verified through `/billing/v1/service-jwks.json`.
- **Stripe commercial-catalog provisioner** — a typed operator command validates pre-existing immutable Products and Prices against stable public metadata and exact terms, then reconciles UOA's four-service credit policies/catalogs and DeepWater privacy add-on in one serializable local transaction. It requires an explicit account, test/live mode, dry-run or apply selection, and an account-and-mode-bound apply confirmation. It neither creates remote Stripe objects nor enables the Stripe runtime gate, and it does not encode account-specific identifiers in source or schema migrations.

---

## Environment Variables

All secrets and configuration live in environment variables. Nothing is hardcoded.

- `SHARED_SECRET` — the single global shared secret for domain hashing and client-domain access tokens
- `AUTH_SERVICE_IDENTIFIER` — optional internal auth-service issuer/audience override for service-issued tokens; defaults to the `PUBLIC_BASE_URL` host and is not required in client config JWTs
- `ADMIN_AUTH_DOMAIN` — domain whose superuser access tokens may access the Admin panel; defaults to the resolved auth service identifier
- `ADMIN_ACCESS_TOKEN_SECRET` — auth-service-only signing secret used for access tokens issued to `ADMIN_AUTH_DOMAIN`; required by admin routes, not process boot
- `ADMIN_CONFIG_JWT` — signed RS256 config JWT served from `/internal/admin/config` for `/admin/login`; required before the production Admin login handoff can work
- `ADMIN_BOOTSTRAP_EMAILS` — optional comma-separated allowlist of emails permitted to bootstrap the initial `SUPERUSER` on `ADMIN_AUTH_DOMAIN`; when unset, the first admin-domain login wins (see brief 22.5)
- `CONFIG_JWKS_URL` — trusted JWKS endpoint for RS256 config JWT verification by `kid`; required by config-backed auth routes, not process boot
- `CONFIG_JWKS_JSON` — public JWKS JSON served from `/.well-known/jwks.json`; must contain public keys only
- `DATABASE_URL` — database connection string for post-context tenant paths (will be scoped to the `uoa_app` role once RLS M2 is enforced; see `Docs/Requirements/row-level-security.md`)
- `DATABASE_ADMIN_URL` — bootstrap/admin connection string used for domain-hash auth, admin routes, auto-onboarding, claim flow, retention pruning, audit log, and `/.well-known/jwks.json`; must connect as a `BYPASSRLS` role (`uoa_admin`). Falls back to `DATABASE_URL` when unset, so local/dev without RLS keeps working unchanged
- Social provider credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, etc.)
- Email service credentials:
  - `EMAIL_PROVIDER` — `disabled` (default behavior) or `smtp`
  - `EMAIL_FROM` — required for `smtp`
  - `EMAIL_REPLY_TO` — optional reply-to address
  - `SMTP_HOST` — required for `smtp`
  - `SMTP_PORT` — optional (default: 587)
  - `SMTP_SECURE` — optional (`true`/`false`, default: `false`)
  - `SMTP_USER` / `SMTP_PASSWORD` — optional (SMTP auth)
- AI translation service credentials
- `ACCESS_TOKEN_TTL` — access token lifetime (minutes-only, 15m–60m; default: 30m)
- `TOKEN_PRUNE_RETENTION_DAYS` — days after refresh-token expiry before expired refresh token rows are pruned (default: 7, max 365)
- `LOG_RETENTION_DAYS` — login log retention window (default: 90, max 365)
- `DEBUG_ENABLED` — include internal error/debug details in responses when set to `true` (default: `false`)
- `VITE_API_BASE_URL` — admin frontend API base URL
- `VITE_ADMIN_BYPASS_AUTH` — development-only admin auth bypass flag; must not be relied on in production
- `MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK` — RS256 private JWK (JSON) shared by confidential token exchange and the optional public-client profile; presence enables signing and publishes its public half at `/oauth/jwks.json`, but does not open public OAuth routes
- `MCP_OAUTH_PUBLIC_PROFILE_ENABLED` — explicit boolean gate for discovery, dynamic registration, authorize, login, and the public PKCE token endpoint; defaults to `false` and additionally requires the signing key plus a valid dedicated `MCP_OAUTH_DOMAIN`
- `MCP_OAUTH_DOMAIN` — **required when the MCP OAuth profile is enabled**; the dedicated first-party tenant domain for `/oauth/*`. Must be distinct from `ADMIN_AUTH_DOMAIN` (and any customer domain) — the service fails closed if it is unset or equals `ADMIN_AUTH_DOMAIN`
- `MCP_OAUTH_ENABLED_AUTH_METHODS` — optional comma-separated auth methods offered on the MCP login screen (default: `email_password`)
- `MCP_OAUTH_SCOPES_SUPPORTED` — optional comma-separated OAuth scopes advertised in MCP discovery metadata (default: `openid`)
- `MCP_OAUTH_RESOURCES_SUPPORTED` — optional comma-separated, case-sensitive allowlist of RFC 8707 resource-server URIs the MCP profile may issue tokens for. A client-supplied `resource` must exactly match one of these or the request is rejected with `invalid_target`; when unset, no resource is allowed and clients omit `resource` (the token `aud` falls back to the issuer)
- `TARIFF_SNAPSHOT_PRIVATE_JWK` — dedicated current private RS256 RSA JWK with a unique `kid`; required together with the tariff public JWKS. Do not reuse the config, OAuth access-token, or signature-evidence key
- `TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON` — public-only JWKS containing the exact current tariff public key plus overlapping retired verification keys. UOA imports the private key and every published public key before serving and fails startup on invalid or mismatched material
- `STRIPE_BILLING_ENABLED` — explicit fail-closed process gate; defaults to `false`
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` — UOA's Stripe request key and the separate raw-body webhook verification secret; neither is an app-to-app product key
- `STRIPE_USAGE_EXPORT_INTERVAL_MINUTES` — recurring active-period export interval (default 60, range 5–1,440)
- `STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES` — exact-team automatic-credit-top-up poll interval (default 1, range 1–60); inactive under the Stripe billing gate
- `STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES` / `STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES` — safety-timer horizon and exact pre-boundary offset; the lead must cover the recurring interval plus offset. The final export is webhook-driven after period end
- `LEDGER_BILLING_BASE_URL` — credential-free HTTPS Ledger origin used only by the UOA collection worker
- `LEDGER_BILLING_APP_KEY` / `LEDGER_BILLING_APP_KEY_ID` — UOA's own dedicated Ledger raw-metering reader `lk_…` secret and exact public `tk_…` record ID; never another product's key
- `LEDGER_BILLING_ASSERTION_AUDIENCE` — exact credential-free HTTPS Ledger origin bound into UOA service assertions
- `UOA_BILLING_ASSERTION_SIGNING_PRIVATE_JWK` — dedicated current private RS256 JWK used only for UOA→Ledger `metering.read` service assertions
- `UOA_BILLING_ASSERTION_PUBLIC_JWKS_JSON` — current and overlapping retired public-only assertion keys served at `/billing/v1/service-jwks.json`
- `BILLING_INVOICE_STORAGE_PROVIDER` — private immutable contract-invoice PDF provider: `disabled` (default), `filesystem`, or `gcs`; production rejects filesystem and issuance fails closed while disabled
- `BILLING_INVOICE_FILESYSTEM_ROOT` — required private root for local/test filesystem invoice storage
- `BILLING_INVOICE_GCS_BUCKET` — required dedicated private bucket when invoice storage is `gcs`; public access prevention and create/read permissions belong only to the UOA runtime identity
- `BILLING_INVOICE_GCS_PROJECT_ID` — optional project override for the invoice bucket
- Contract invoice PDFs embed the vendored DejaVu Sans regular/bold fonts under `assets/fonts/`; the runtime image copies those licensed assets and `@pdf-lib/fontkit` supplies Unicode shaping/subsetting.
- `SIGNATURE_STORAGE_PROVIDER` — optional signature-object provider: `disabled` (default), `filesystem`, or `gcs`; filesystem storage is rejected in production
- `SIGNATURE_FILESYSTEM_ROOT` — required private root when `SIGNATURE_STORAGE_PROVIDER=filesystem`; intended only for local development and tests
- `SIGNATURE_GCS_BUCKET` — required private bucket when `SIGNATURE_STORAGE_PROVIDER=gcs`
- `SIGNATURE_GCS_PROJECT_ID` — optional Google Cloud project override; authentication otherwise uses Application Default Credentials
- `SIGNATURE_MALWARE_SCANNER` — `disabled` (default/fail closed for uploads) or `clamav`; enabled domains require `clamav`
- `SIGNATURE_CLAMDSCAN_PATH` — ClamAV daemon scanner executable path (default `clamdscan`); invoked without a shell
- `SIGNATURE_MALWARE_SCAN_TIMEOUT_MS` — per-upload ClamAV timeout (default 30,000; allowed 1,000–120,000)
- `SIGNATURE_EVIDENCE_PRIVATE_JWK` — dedicated private RSA JWK with `kid` used only for RS256 agreement-evidence manifests
- `SIGNATURE_EVIDENCE_PUBLIC_JWKS_JSON` — public-only current and retired evidence keys used to verify historical manifests after rotation
- `SIGNATURE_MAX_PDF_BYTES` — bounded source upload limit (default 25 MiB, allowed 1 KiB–100 MiB)
- `SIGNATURE_MAX_PDF_PAGES` — bounded source page limit (default 200, allowed 1–2,000)
- `SIGNATURE_CONTINUATION_TTL_MINUTES` — short-lived signing capability lifetime (default 10, allowed 2–30 minutes)
- `SIGNATURE_MAX_SIGN_ATTEMPTS` — maximum failed signing submissions before a continuation is rejected (default 10, allowed 1–50)
