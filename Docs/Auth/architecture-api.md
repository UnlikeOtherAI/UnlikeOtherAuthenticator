# API Architecture

This document defines the internal architecture for the `/API` directory — the central OAuth/auth server.

For the full product spec, see [brief.md](./brief.md). For tech stack, see [techstack.md](./techstack.md).

---

## Guiding Principles

- **No code file longer than 500 lines.** If a file approaches this limit, split it.
- **One responsibility per file.** A route file handles routing. A service file handles logic. They don't mix.
- **Thin routes, fat services.** Route handlers validate input, call a service, and return a response. Business logic lives in services.
- **Flat over nested.** Prefer shallow directory structures. Avoid deeply nested folders.
- **Explicit over clever.** Straightforward code beats abstractions. No magic.

---

## Directory Structure

The tree below reflects the current `API/src` layout. It is a snapshot — when a new file, route, or service is added, this tree must be updated in the same change. The principles in the rest of this document (thin routes, fat services, one responsibility per file, 500-line cap) are the durable contract; the tree is the index.

```
/API
  /src
    app.ts                  — Fastify app setup, plugin and middleware registration
    server.ts               — Server entry point
    /cli
      provision-stripe-commercial-catalog.ts — Guarded Stripe catalog validation and local provisioning entry point
      stripe-catalog-provisioning-args.ts — Exact dry-run/apply, account, mode, and confirmation parsing
    /config
      billing-env-validation.ts — Tariff, Stripe, and Ledger collector startup invariants
      constants.ts          — App-wide constants (token TTL defaults, retention defaults)
      env.ts                — Environment variable loading and validation
      jwt.ts                — JWT signing/verification configuration
    /db
      prisma.ts             — Prisma client construction (anonymous + tenant-scoped)
      tenant-context.ts     — RLS tenant-context helpers
    /plugins
      tenant-context.plugin.ts — Fastify plugin that wires per-request RLS tenant context
    /middleware
      admin-superuser.ts            — Validates admin access token + superuser role for /internal/admin/*
      billing-app-auth.ts            — Authenticates a product-bound app key for /billing/v1/*
      config-jwt-header-verifier.ts — Verifies signed config JWT supplied via header
      config-verifier.ts            — Fetches config URL, verifies JWT, attaches config to request
      domain-hash-auth.ts           — Verifies domain hash token for domain-scoped APIs
      error-handler.ts              — Global error handler (generic user-facing errors, detailed internal logs)
      groups-enabled.ts             — Returns 404 when groups are disabled
      org-features.ts               — Returns 404 when org features are disabled
      org-role-guard.ts             — Validates user access token and org role for /org endpoints
      rate-limiter.ts               — Rate limiting
      same-origin-browser.ts        — Rejects cross-site browser mutations on capability signing actions
      superuser-access-token.ts     — Validates user access tokens for superuser-only domain endpoints
    /routes
      index.ts              — Top-level route registration and global 404 handler
      admin-ui.ts           — Serves the static admin SPA bundle
      config-jwks.ts        — GET /.well-known/jwks.json (public config JWT verification keys)
      /root
        index.ts            — GET / (holding page) and GET /api (full endpoint schema)
        llm.ts              — GET /llm (Markdown config documentation for LLM consumers)
        llm-intro.ts        — /llm content: introduction section
        llm-integration.ts  — /llm content: integration section
        config-docs.ts      — Shared documentation blocks for /api (config JWT, access token, etc.)
        config-validate.ts  — POST /config/validate (lint a candidate config JWT)
        config-verify.ts    — POST /config/verify (verify a signed config JWT)
        schema.ts           — Aggregates the endpoint schema returned by /api
        schema.auth.ts      — /api schema slice: auth endpoints
        schema.billing.ts   — /api schema slice: tariffs, contract invoices, app keys, and snapshots
        schema.billing-funding.ts — /api schema slice: shared-credit and recurring-add-on reads/artifacts
        schema.config-debug.ts — /api schema slice: config debug endpoints
        schema.integrations.ts — /api schema slice: integration endpoints
        schema.internal-admin-apps.ts — /api schema slice: internal admin app/settings/search endpoints
        schema.internal-admin-signatures.ts — /api schema slice: signature settings and agreement lifecycle endpoints
        schema.platform.ts  — /api schema slice: root, health, app, email, and domain endpoints
        schema.signatures.ts       — /api schema slice: signing session, signer, domain-status, and public verification endpoints
        schema.internal-admin.ts — /api schema slice: internal admin endpoints
        llm-billing.ts        — /llm content: product billing integration and raw-usage rules
        llm-signatures.ts     — /llm content: optional signature operator workflow and security constraints
      /apps
        startup.ts          — GET /apps/startup (combined startup payload; config JWT auth)
        index.ts            — Route registration for /apps
      /auth
        login.ts            — POST /auth/login
        register.ts         — POST /auth/register
        verify-email.ts     — POST /auth/verify-email
        reset-password.ts   — POST /auth/reset-password
        callback.ts         — GET  /auth/callback/:provider
        social.ts           — GET  /auth/social/:provider
        token-exchange.ts   — POST /auth/token
        revoke.ts           — POST /auth/revoke
        entrypoint.ts       — GET  /auth (main auth entry)
        domain-mapping.ts   — Auth-flow domain mapping helper
        rate-limit-keys.ts  — Shared rate-limit key helpers for auth routes
        email-reset-password.ts    — GET /auth/email-reset-password
        email-registration-link.ts — GET /auth/email-registration-link
        email-twofa-reset.ts       — GET /auth/email-twofa-reset
        email-team-invite.ts       — GET /auth/email-team-invite
        email-team-invite-open.ts  — GET /auth/email-team-invite-open
        index.ts            — Route registration for /auth
      /billing
        credits.ts          — POST /billing/v1/credits and strict BillingCreditsV1 validation
        customer-statement.ts — Exact v1/v2 display model and public protocol artifacts
        effective-tariff.ts — Product-bound app-key + signed-actor tariff resolution
        funding-artifacts.ts — Public credit/add-on JSON Schema, fixture, and OpenAPI artifacts
        jwks.ts             — GET /billing/v1/jwks.json (snapshot verification keys)
        recurring-addons.ts — Strict add-on read, Checkout, cancellation-preview, and cancellation-confirm routes
        stripe-checkout.ts  — Purpose-bound hosted Checkout creation/recovery
        stripe-subscription.ts — Safe summary, portal, and period-end cancellation
        stripe-webhook.ts   — Exact-raw-body Stripe lifecycle reconciliation
        index.ts            — Route registration for /billing/v1
      /domain
        users.ts            — GET  /domain/users
        logs.ts             — GET  /domain/logs
        debug.ts            — GET  /domain/debug
        signatures.ts       — POST /domain/signatures/status (verified config + domain hash)
        index.ts            — Route registration for /domain
      /signatures
        session.ts          — Capability-scoped signing state, source, submit, receipt, and completion
        me.ts               — Access-token subject status and receipt downloads
        verify.ts           — Public PII-minimised evidence/source/receipt integrity verification
        index.ts            — Route registration for /signatures
      /email
        send.ts             — POST /email/send (transactional email send)
        index.ts            — Route registration for /email
      /health
        index.ts            — GET  /health
      /i18n
        get.ts              — GET /i18n/:language
        index.ts            — Route registration for /i18n
      /integrations
        claim.ts            — Integration request claim flow
        index.ts            — Route registration for /integrations
      /internal
        /admin
          billing.ts                — Superuser tariff, assignment, and app-key lifecycle
          billing-contract-invoices.ts — Contract/version, profile, calculator, invoice, PDF, and settlement routes
          billing-contract-invoice-response-schemas.ts — Exact final-price-only invoice response schemas
          billing-serialization.ts  — Billing admin response serialization
          confidential-delegations.ts — Audited superuser delegation-mapping CRUD
          config.ts                 — GET  /internal/admin/config (admin auth config)
          token.ts                  — POST /internal/admin/token (admin token exchange)
          read.ts                   — Read endpoints powering the admin panel
          domains.ts                — Domain CRUD for the admin panel
          domain-email.ts           — Per-domain transactional email config + SES identity flow
          domain-jwks.ts            — Per-domain JWKS management
          domain-signature-operations.ts — Signature evidence search, audited receipt access, and revocation
          domain-signatures.ts      — Per-domain signature settings, agreement/version lifecycle, and source downloads
          apps.ts                   — App registration for feature flags
          superusers.ts             — Super-user grant/revoke for ADMIN_AUTH_DOMAIN
          users.ts                  — User admin write operations (2FA reset)
          integration-requests.ts   — Integration-request management
          index.ts                  — Route registration for /internal/admin
        /org
          groups.ts                 — POST/PUT/DELETE internal group operations
          group-members.ts          — POST/PUT/DELETE internal group members
          team-group-assignment.ts  — PUT team↔group assignment
          index.ts                  — Route registration for /internal/org
      /org
        me.ts               — GET /org/me
        organisations.ts    — Organisations + memberships + ownership transfer
        teams.ts            — Teams + team membership operations
        team-invitations.ts — Team invitation lifecycle endpoints
        team-route.shared.ts — Shared helpers used by team and team-invitation routes
        groups.ts           — GET group operations (org-aware reads)
        access-requests.ts  — Team/org access-request endpoints
        domain-context.ts   — Resolve domain context for org-scoped flows
        index.ts            — Route registration for /org
      /twofactor
        self-service.ts     — POST /2fa/setup, /2fa/enroll, /2fa/disable
        verify.ts           — POST /2fa/verify
        reset.ts            — POST /2fa/reset
        index.ts            — Route registration for /2fa
    /services
      access-request-flow.service.ts        — Orchestration for access-request flow
      access-request.service.ts             — Access-request orchestration API
      access-request.service.admin.ts       — Access-request admin operations
      access-request.service.auth.ts        — Access-request auth-flow integration
      access-request.service.base.ts        — Access-request service building blocks
      access-token.service.ts               — Access-token issuance and verification
      admin-auth-config.service.ts          — Admin auth config builder
      admin-superusers.service.ts           — Super-user management for the admin domain
      admin-ui.service.ts                   — Resolves the admin SPA asset URLs
      app-startup.service.ts                — /apps/startup orchestration
      audit-log.service.ts                  — Audit-log writes
      auth-debug-page.service.ts            — HTML rendering for /domain/debug
      auth-domain-mapping.service.ts        — Auth-flow domain mapping
      auth-login.service.ts                 — Login logic
      auth-register.service.ts              — Registration logic
      auth-registration-email-link.service.ts — Registration email link generation
      auth-reset-password.service.ts        — Password reset logic
      auth-ui.service.ts                    — Auth window HTML/asset rendering
      auth-verify-email.service.ts          — Email verification logic
      verification-token-epoch.service.ts  — Issue-time user/credential-epoch proof and lock enforcement
      auto-onboarding.service.ts            — Auto-onboarding flow
      authorization-code.service.ts         — Scoped code issuance and one-transaction consumption
      billing-actor.service.ts              — Credential-bound short-lived actor JWT verification
      billing-app-key.service.ts            — Product app-key minting, lookup, revocation, and audit
      billing-credit-account.service.ts     — Exact Stripe account/mode shared-team credit account and portfolio perspective
      billing-credit-display.service.ts     — Exact microcredit/credit/USD display conversion
      billing-credit-entry-projection.service.ts — Manager/member-safe credit-entry attribution
      billing-credit-projection-data.service.ts — Credit, funding-policy, settlement, allocation, and pending-payment reads
      billing-credit-projection.service.ts  — Strict manager/member BillingCreditsV1 view model
      billing-credit-rating.service.ts      — Deterministic all-service tariff rating and scarce-credit allocation
      billing-credit-settlement-write.service.ts — Append-only settlement, entry, and allocation persistence
      billing-credit-settlement.service.ts  — Serializable cursor-idempotent team portfolio settlement
      billing-credits.service.ts            — Credits read orchestration across entitlement, Ledger, settlement, and projection
      billing-entitlement.service.ts        — Membership validation and team→org→default resolution
      billing-funding-viewer.service.ts      — Exact-scope manager/member visibility resolution
      billing-ledger-collector.service.ts   — Strict immutable Ledger usage/portfolio snapshots
      billing-rating.service.ts             — Shared exact statement, Stripe, and contract-invoice rating core
      billing-recurring-addons.service.ts   — Privacy-safe exact-scope recurring add-on projection
      billing-recurring-addon-catalog.service.ts — Immutable offer/catalog to exact Stripe Product/monthly Price binding
      billing-recurring-addon-checkout.service.ts — Scope-authorized one-item add-on Checkout and race recovery
      billing-recurring-addon-cancellation-preview.service.ts — Current-state refresh and opaque five-minute cancellation capability
      billing-recurring-addon-cancellation-confirm.service.ts — Locked replay-safe period-end cancellation
      billing-recurring-addon-subscription.service.ts — Exact Stripe add-on subscription validation and terminal projection
      billing-recurring-addon-webhook.service.ts — Signed/current Checkout, subscription, and initial-invoice proof
      billing-recurring-addon-webhook-apply.service.ts — Atomic add-on projection, activation, and deactivation writes
      billing-contract-guard.service.ts     — Active-contract assignment mutation guard
      billing-contract.service.ts           — Immutable org contracts and atomic service tariff projection
      billing-invoice-calculation.service.ts — Closed-month org calculator and private evidence persistence
      billing-invoice-lifecycle.service.ts  — Serial issuance, PDF integrity, void, and settlement lifecycle
      billing-invoice-pdf.service.ts        — Final-price-only immutable PDF generator
      billing-invoice-profile.service.ts    — Explicit issuer/buyer legal profiles
      billing-invoice-storage.service.ts    — Dedicated private create-only invoice PDF storage
      billing-invoice-view.service.ts       — Exact customer-safe invoice serializer and settlement projection
      billing-statement-portfolio.service.ts — UOA-only connected-service/origin/user aggregation
      billing-statement.service.ts          — Canonical display-ready v1/v2 billing statements
      billing-snapshot.service.ts           — Preloaded RS256 tariff signer, overlapping JWKS, and exact consumer binding guard
      billing-stripe-checkout-recovery.service.ts — Crash-safe Stripe Checkout lookup and lease reconciliation
      billing-stripe-checkout-state.service.ts — Billing-scope overlap, binding, and customer projection rules
      billing-stripe-client.service.ts      — Explicit Stripe account and test/live runtime identity
      billing-stripe-catalog-provisioning.service.ts — Read-first provisioning orchestration and serializable apply
      billing-stripe-catalog-provisioning-spec.ts — Canonical credit and DeepWater privacy commercial terms
      billing-stripe-catalog-provisioning-remote.service.ts — Exact read-only Stripe contract validation
      billing-stripe-catalog-provisioning-local.service.ts — Local account, app feature, and add-on reconciliation
      billing-stripe-catalog-provisioning-credits-local.service.ts — Local credit policy, offer, option, and catalog reconciliation
      billing-stripe-catalog-provisioning-local.shared.ts — Narrow transaction, action, and drift primitives
      billing-stripe-invoice.service.ts     — Authoritative post-period invoice reconciliation
      billing-stripe-manager.service.ts     — Org/team billing-manager authorization
      billing-stripe-period.service.ts      — Calendar-month and free-alignment classification
      billing-stripe-return-url.service.ts  — Exact HTTPS origin allowlist enforcement
      billing-stripe-scheduler.service.ts   — Recurring exports and pre-boundary safety pass
      billing-stripe-subscription.service.ts — Safe summaries, portal, and cancellation lifecycle
      billing-stripe-tariff-guard.service.ts — Live Checkout/subscription tariff pin guards
      billing-tariff-read.service.ts        — Admin tariff, assignment, account/mode, and subscription projection
      billing-tariff.service.ts             — Versioned catalog, defaults, and assignments
      client-jwk.service.ts                 — Client-side JWK helpers
      config-debug.service.ts               — Config debug introspection
      config-fetch.service.ts               — Config URL fetch
      config-fetch-diagnostics.service.ts   — Config fetch diagnostics
      config-jwks.service.ts                — Config JWKS fetch/cache
      config-jwt-source.service.ts          — Config JWT source resolution
      config-secret-scan.service.ts         — Config secret-leak scanning
      config-validation-guidance.service.ts — Config validation guidance text
      config.service.ts                     — Config JWT verification orchestrator
      confidential-assertion-use.service.ts — Durable source+jti one-time claims for confidential exchange
      confidential-chained-token-exchange.service.ts — Verify and narrow UOA-issued audience-bound subjects for app-to-app chains
      confidential-delegation.service.ts — ClientDomain/product/resource/scope policy and audited CRUD
      confidential-token-exchange.service.ts — Verify source assertions, re-resolve workspace identity, and issue resource tokens
      domain-email-config.service.ts        — Per-domain email config + SES wiring
      domain-role.service.ts                — Domain role lookups (superuser etc.)
      domain-secret.service.ts              — Domain shared-secret management
      domain-users.service.ts               — Domain users listing
      email-theme.service.ts                — Email template theming
      email.providers.ts                    — Email provider implementations
      email.service.ts                      — Email dispatch entry point
      email.templates.ts                    — Email template registry
      first-login.service.ts                — First-login bootstrapping
      group.service.ts                      — Group orchestration API
      group.service.base.ts                 — Group service building blocks
      group.service.groups.ts               — Group CRUD
      group.service.members.ts              — Group membership lifecycle
      handshake-error-log.service.ts        — Handshake error logging
      handshake-log-context.service.ts      — Handshake log context builder
      integration-accept.service.ts         — Integration accept flow
      integration-claim-page.service.ts     — Integration claim HTML page
      login-session-use.service.ts          — Hashed one-use chooser capability claims
      integration-claim.service.ts          — Integration claim logic
      integration-request-notify.service.ts — Integration request notifications
      integration-request.service.ts        — Integration request orchestration
      integration-status-page.service.ts    — Integration status HTML page
      internal-admin.service.ts             — Shared logic for /internal/admin/* (orchestration entry point)
      internal-admin.service.apps.ts        — Admin app registration and app summary formatting
      internal-admin.service.base.ts        — Internal-admin service building blocks
      internal-admin.service.domains.ts     — Domain admin operations
      internal-admin.service.organisations.ts — Organisation admin operations
      internal-admin.service.users.ts       — User admin operations
      jwks-fetch.service.ts                 — JWKS fetch helper
      login-log.service.ts                  — Login log writes
      login-code.service.ts                 — Epoch-bound one-time email login-code issue and consumption
      org-context.service.ts                — Resolve user org context for JWT enrichment and /org/me
      org-placement.service.ts              — Org placement decisions during onboarding
      organisation.service.base.ts          — Organisation service building blocks
      organisation.service.lifecycle.ts     — Org deactivation/reactivation with ordered membership locking
      organisation.service.organisation.ts  — Organisation CRUD + slug generation (slice entry point)
      organisation.service.members.ts       — Org membership lifecycle
      password.service.ts                   — Hashing, validation rules, comparison
      refresh-session-lock.service.ts       — Canonical user-global then user/domain serialization
      refresh-token-revocation.service.ts   — Domain/workspace/global revocation transactions
      refresh-token-rotation-policy.service.ts — Workspace/signature gates held through refresh rotation
      refresh-token.service.ts              — Refresh issuance, rotation, reuse detection, family logout
      refresh-token-transaction.service.ts  — Durable reuse revocation commit before opaque rejection
      retention-pruning.service.ts          — Retention pruning jobs
      root-page.service.ts                  — Root holding page rendering
      ses-admin.service.ts                  — AWS SES identity admin operations
      signature-evidence.service.ts         — Canonical evidence manifests, dedicated RS256 signatures, and receipt orchestration
      signature-admin-audit.service.ts      — Dual signature-specific and global Admin audit writes
      signature-admin-operations.service.ts — Domain-scoped evidence search, receipt integrity/access, and revocation
      signature-admin.service.ts            — Domain signature settings and agreement metadata lifecycle
      signature-agreement-lifecycle.service.ts — Draft PDF upload/replacement/deletion and private source reads
      signature-agreement-publication.service.ts — Serialized publish/supersede/withdraw transitions
      signature-malware.service.ts          — Fail-closed ClamAV scanning through private temporary files
      signature-pdf.service.ts              — Source-PDF safety validation, hashing, and certificate-page receipt generation
      signature-policy.service.ts           — Per-domain required-agreement evaluation and fail-closed completion checks
      signature-continuation.service.ts     — Hashed one-use signing continuations and atomic authorization-code gates
      signature-signing.service.ts          — Capability-scoped signing, exact evidence capture, idempotency, and receipts
      signature-access.service.ts           — Signer/domain status, subject receipts, and public integrity verification
      signature-storage.service.ts          — Private immutable signature-object storage adapters (filesystem/GCS)
      team-invite.service.ts                — Team invite orchestration API
      team-invite.service.base.ts           — Team invite service building blocks
      team-invite.service.acceptance.ts     — Team invite acceptance flow
      team-invite.service.management.ts     — Team invite create/list/revoke
      team-invite.service.token.ts          — Team invite token issuance/verification
      team.service.ts                       — Team orchestration API
      team.service.base.ts                  — Team service building blocks
      team.service.teams.ts                 — Team CRUD
      team.service.members.ts               — Team member lifecycle
      token.service.ts                      — Access token, refresh token, and authorization code orchestration
      totp.service.ts                       — TOTP secret generation and verification
      totp-qr.service.ts                    — Logo'd TOTP QR SVG rendering
      translation.service.ts                — AI translation fallback and caching
      twofactor-challenge.service.ts        — 2FA challenge lifecycle
      twofactor-disable.service.ts          — 2FA disable/reset helpers
      twofactor-enroll.service.ts           — 2FA enrollment
      twofactor-login.service.ts            — 2FA login verification
      twofactor-policy.service.ts           — DB-backed 2FA policy resolution
      twofactor-reset.service.ts            — 2FA reset flow
      twofactor-setup.service.ts            — 2FA setup orchestration
      twofactor-setup-token.service.ts      — Short-lived setup token signing/verification
      user-scope.service.ts                 — User scope handling (global vs per-domain)
      user-team-requirement.service.ts      — Per-domain team-requirement enforcement
      workspace-scope.service.ts            — Ordered membership locks and exact ACTIVE-scope checks
      /social
        apple.service.ts                    — Apple OAuth flow
        facebook.service.ts                 — Facebook OAuth flow
        github.service.ts                   — GitHub OAuth flow
        google.service.ts                   — Google OAuth flow
        linkedin.service.ts                 — LinkedIn OAuth flow
        provider.base.ts                    — Shared interface and email verification enforcement
        social-login.service.ts             — Shared social-login orchestration
        social-state.service.ts             — Social-state OAuth parameter signing
        index.ts                            — Social provider registry
    /utils
      app-logger.ts                  — Structured logger (internal details only)
      billing-app-key.ts             — Product app-key generation, digest, and display prefix
      claim-secret-crypto.ts         — Claim-secret cryptographic helpers
      client-hash.ts                 — Client-hash helpers
      display-prefixes.ts            — Public-display ID prefixes
      domain.ts                      — Domain helpers
      email-domain.ts                — Email-domain parsing
      error-auth-provider-explanations.ts — Auth-provider error explanations
      error-response.ts              — Public error-body builder
      errors.ts                      — Generic error factory (never leaks specifics)
      hash.ts                        — Hashing helpers (domain + secret, tokens)
      http-url.ts                    — HTTP URL validation
      pkce.ts                        — PKCE helpers
      rs256-jwk.ts                   — Shared private/public RSA JWK structural validation
      ssrf.ts                        — SSRF safeguards
      static-file.ts                 — Static-file serving helpers
      theme-sanitizer.ts             — Theme sanitization
      twofa-secret.ts                — 2FA secret helpers
      verification-token.ts          — Verification token helpers
  /prisma
    schema.prisma                    — Database schema
    /migrations                      — Prisma migration files
```

Notes on layout:

- `/db` and `/plugins` are first-class peers of `/middleware` and `/services` because RLS tenant context is wired via a Fastify plugin and shared helpers in `/db`.
- `/routes/root` contains the documentation and config-debug endpoints. The `schema.*.ts` files are slice modules that compose into `schema.ts`, which is what `GET /api` ultimately returns.
- Service families that exceed the 500-line cap are split with the `<domain>.service.<slice>.ts` pattern (see `team.*`, `group.*`, `team-invite.*`, `access-request.*`, `internal-admin.*`, `organisation.*`). Most families keep an unsuffixed `<domain>.service.ts` orchestration entry point that re-exports the public API; the `organisation.*` family currently has no such entry and callers import the slice files directly.
- SCIM is not present in the tree. The full SCIM spec remains in `Docs/Requirements/roles-and-acl.md` and is deferred. When implementation lands, add a `/routes/scim` subtree and a `scim-auth` middleware and update this document.

---

## Layered Architecture

```
Request → Route → Middleware → Service → Database (Prisma)
                                ↓
                          External APIs
                     (social providers, email, AI)
```

### Routes (thin)

- Parse and validate request input
- Call the appropriate service
- Return the response
- No business logic
- Each route file handles one endpoint or a tight group of related endpoints

### Middleware

- **config-verifier** — runs on OAuth entry points and the server-facing `GET /apps/startup` endpoint. Fetches config from URL, verifies JWT, attaches parsed config to the request context. **Bypass exceptions** (SDK-facing or unauthenticated documentation endpoints called without a backend config context): `GET /` (holding page), `GET /api` (JSON schema), `GET /llm` (Markdown config docs), `GET /.well-known/jwks.json`, the `/health` endpoint, and the static admin SPA served under `/admin`.
- **config-jwt-header-verifier** — verifies a signed config JWT supplied via header for endpoints that accept the config out-of-band rather than via a `config_url` query parameter.
- **domain-hash-auth** — runs on domain-scoped API routes. Verifies the domain hash token.
- **superuser-access-token** — validates user access tokens for superuser-only domain endpoints.
- **admin-superuser** — runs on `/internal/admin/*`. Validates the admin access token issued by `POST /internal/admin/token` and requires `role: "superuser"` for the configured `ADMIN_AUTH_DOMAIN`. See `Docs/Requirements/roles-and-acl.md`.
- **billing-app-auth** — runs on the product billing endpoints. Accepts only the calling product's individual `uoa_app_…` credential, resolves its exact product, purpose, and actor-verification binding through the admin database connection, and rejects duplicate or ambiguous credential headers. `entitlement` keys can call only effective-tariff; `customer_lifecycle` keys can call only direct-session confirmation, customer statement, Checkout, summary, portal, and cancellation. The route separately requires `X-UOA-Actor`; the app key never stands in for a user identity. The signed result includes the non-secret app-key record ID, exact product ID/identifier, and user/organisation/team subject so consumers can reject cross-product or cross-actor replay even when products share an actor-signing key.
- **org-features** — rejects org endpoints when `org_features.enabled` is false.
- **groups-enabled** — rejects group endpoints when `org_features.groups_enabled` is false.
- **org-role-guard** — validates the user access token and the user's org role for `/org/*` routes (`owner > admin > member`). Reads `OrgMember.role` for the authenticated user in the target org and returns 403 if not a member or the role is insufficient.
- **error-handler** — catches all errors. Returns a generic public body via `utils/error-response.ts` to the caller and logs specifics internally.
- **rate-limiter** — request rate limiting; keyed helpers for auth routes live in `routes/auth/rate-limit-keys.ts`.

Refresh and revocation use one lock hierarchy: product-policy read lock when applicable, exact
user-global, exact user+normalized-domain when applicable, then organisation/team membership and
signature-policy locks. Refresh discovers identity by opaque lookup, takes the session locks, and
re-reads before any decision. Org lifecycle takes user-global + user/domain before membership;
team lifecycle takes user-global before membership. Their `uoa_admin` transactions atomically write
status and revoke exact cross-domain workspace families plus legacy same-domain rows as applicable.
Reuse revokes its family and commits through the private transaction outcome before the opaque 401.

Family logout follows opaque lookup → user-global → user/domain → re-read, and commits family
revocation with the access-token version bump. Password reset, verify-email password binding, email
2FA reset, authenticated 2FA disable, and admin 2FA reset use one `uoa_admin` transaction: take
user-global, mutate the credential, revoke all refresh rows, bump `tokenVersion`. This prevents a
concurrent refresh from inserting a live replacement or signing with the newly bumped version.
Reactivation/re-add never clear revoked state.

Existing-user `VerificationToken` capabilities carry immutable `userId` + issue-time
`tokenVersion`. Their read paths fail stale or legacy-null bindings closed; their mutation paths
take user-global, re-read that exact epoch, then evaluate expiry from a fresh post-lock clock before
any side effect. This covers password/2FA resets, login codes and links, verify-email, and
invite-bound links, so one credential-epoch bump invalidates every sibling capability. Only a true
pre-user registration row may carry null/null, and it remains valid only while its `userKey` has no
user. Migration does not backfill historical null epochs because the issue-time value is unknowable.

Signed login-session and 2FA challenge/setup continuations use the same decision-time rule. Routes
may verify once to discover the lock identity, but after product-policy and authentication-epoch
locks they re-verify the original JWT with a fresh `Date` and use only those refreshed claims.
Tokens that expire in the lock queue therefore cannot drive chooser reads, invitation mutations,
secret decryption, TOTP verification/enrollment, finalization, or authorization-code issuance.

`POST /auth/token` remains a thin multi-grant route. Its confidential assertion
branch uses the same config verifier and domain-hash guard as the legacy grants,
retains the authenticated `ClientDomain.id`, and resolves an enabled
ClientDomain + product mapping before assertion work. The mapping contains one
exact HTTPS resource and an allowlist limited to `ai.invoke`, `billing.read`,
and the separately granted `token.provision`;
the issued scope is the exact requested subset. This separates app provenance
(the individual product's domain credential) from user/org/team provenance (the
source-signed assertion), with no shared key, user-token substitution, or env
fallback. It then delegates source-JWKS verification, current identity
resolution, conditional selected-workspace resolution, and RS256 issuance to
`confidential-token-exchange.service.ts`. Pre-context reads use the admin Prisma
client because the user tenant is not trusted until the assertion, user, domain
role, and any selected memberships have been verified. Immediately after those
checks, `confidential-assertion-use.service.ts` atomically inserts a hashed
source-domain + `jti` claim through accepted expiry plus clock tolerance; the
database uniqueness constraint serializes concurrent exchanges across processes
before access-token signing.

The chained branch accepts
`subject_token_type=urn:ietf:params:oauth:token-type:access_token` only for an
already UOA-issued RS256 `at+jwt` whose audience exactly equals the authenticated
next-hop app's HTTPS config domain. The immediate caller still authenticates
with its own app credential and mapping. UOA revalidates the inbound source
mapping, then revalidates stable user/domain-role and ACTIVE org/team identity
under the ultimate signed origin at the tail of `act`. It narrows the requested
scope through both hops and caps the result to the inbound expiry. The output
identifies the immediate caller in `source_domain`/`azp`/`product` and records
the upstream product chain in `act`. Access-token subjects remain reusable until
expiry for concurrent multi-process calls; only source-signed JWT assertions use
the one-time assertion ledger.

Both direct source assertions and chained UOA access-token subjects require an explicit
nonnegative integer `tv`, including epoch zero. Missing `tv` is invalid rather than being coerced to
zero. The exchange takes the canonical user lock, compares that claim with the current credential
epoch, and propagates the exact accepted epoch into the output token.

`confidential-delegation.service.ts` owns both fail-closed runtime resolution
and the audited superuser CRUD exposed by
`routes/internal/admin/confidential-delegations.ts`. The security-sensitive
`confidential_delegation_mappings` table is available only to `uoa_admin`, with
forced RLS and a deny-all `uoa_app` policy. Mappings bind ClientDomain rather
than an individual secret row so normal per-domain credential rotation remains
valid without ever storing or returning plaintext credentials.

The billing boundary is deliberately server-to-server. A purpose-bound product
app key authenticates the exact deployment, while its credential-bound RS256
actor JWT binds each request to one active UOA user, organisation, and team for
no more than 60 seconds. `billing-entitlement.service.ts` validates both
membership levels and resolves team assignment → organisation assignment →
service default without mutating direct product-access evidence.
`billing-snapshot.service.ts` signs the five-minute content-free entitlement
result. `billing-statement.service.ts` separately builds the display-ready
`BillingStatementV1` or `BillingStatementV2` from the exact tariff, UOA
add-ons/credits, Stripe projection, and immutable raw Ledger snapshots. V1
remains frozen. V2 adds a UOA-aggregated team-wide connected-service portfolio
from one exact user-grouped `metering-portfolio-v1` snapshot. UOA derives the
commercial rating and all service/origin/user totals from that same pinned fact
set; only the requested product is commercially rated. Other products, origins,
and users are display-only transparency and cannot affect the current statement
total. Null legacy origin attribution remains unattributed and cannot create a
service or cancellation choice. Effective-tariff and statement reads are
passive: only the explicit post-SSO service-access confirmation route may create
or refresh direct-access evidence.
Tariff, direct-access, commercial-line, and credential reads use the bypass-RLS
admin client because tenant SQL access to those control-plane tables is denied.
Full contract and raw-usage separation are defined in
`Docs/Requirements/billing-tariffs.md`.

The shared-credit read is a state-changing settlement boundary behind a
read-shaped product API. `billing-credits.service.ts` authenticates the exact
lifecycle key/actor/subject, resolves one stable team portfolio perspective,
fetches one current-month `metering-portfolio-v1` cursor grouped by user, and
passes it to `billing-credit-settlement.service.ts`. That service takes the
shared credit-account row lock in a serializable transaction and settles every
current or previously seen service together. It pins each service's first
effective tariff, applies corrections before new debits, allocates scarce
credits deterministically, and writes the full rated-but-unfunded liability.
Usage cannot push an available balance below zero; only verified credit-entry
reversals can produce debt. Cursor replay is idempotent and a conflicting or
partially persisted cursor fails closed. `billing-credit-projection.service.ts`
then returns the strict manager or member protocol branch, with `Remaining
credits` first and no cross-user/card leakage to members. Recurring add-ons use
the same lifecycle and viewer boundary but remain a separate subscription and
entitlement path. Managers relay exact frozen actions to UOA's Checkout and
cancellation routes. Checkout creates a one-item licensed monthly Stripe
subscription but no entitlement; only an exact undiscounted initial
`invoice.paid` proof activates it. Opaque five-minute cancellation intents are
single-use, exact-subject-bound, row-locked, and replay their stored result.
Stripe lifecycle events terminalize the entitlement without resurrection.

The platform-superuser contract-invoice boundary is separate from the
product-facing statement. `billing-contract.service.ts` owns immutable
organisation contract versions and atomic CUSTOM+MANUAL tariff projection;
`billing-invoice-calculation.service.ts` fetches closed-month organisation-level
Ledger snapshots and uses the shared `billing-rating.service.ts` core;
`billing-invoice-lifecycle.service.ts` owns serial numbering, issuance, voiding,
and append-only settlement events. The customer-safe serializer and exact route
schema expose final per-service prices only. Private Ledger cursor/hash evidence
and the calculation digest remain in admin-only RLS tables and never enter the
DTO or `billing-invoice-pdf.service.ts`. Credits remain a separate settlement
value rather than changing a line: `billing-contract-funding-evidence.service.ts`
accepts only the latest canonical funded exact-team settlement adjustment and
the database gives manual invoices and Stripe one shared collector lock. Paid
recurring add-ons retain their canonical Stripe subscription and appear only as
immutable, separately collected display lines excluded from amount due. Contract,
version, issuer, buyer, and invoice
routes all use exact response schemas. Issuance renders embedded DejaVu Unicode
fonts with measured wrapping, writes create-only PDFs through the dedicated
invoice storage abstraction, and re-verifies SHA-256 on download.
See `Docs/Requirements/contract-invoicing.md`.

The API re-exports the MIT-licensed
`@unlikeotherai/billing-statement-protocol` workspace instead of owning a
private copy of the customer contract. That package is the source for the
TypeScript types and runtime schema and generates drift-checked JSON Schema,
synthetic example, and OpenAPI 3.1 artifacts. It covers
`BillingStatementV1`, additive `BillingStatementV2`, and the exact
product-facing hosted redirect, cancellation preview/confirm, selection, and
error messages, plus discriminated `BillingCreditsV1` and recurring-add-on
manager/member views. The API serves all artifact sets under `/schemas/`; consumers
can pack/vendor the package without importing server code. Billing action
capabilities do not replace the App feature-flag resolver.

`feature-flag-resolution.service.ts` is shared by `/apps/startup` and the
backend-only `GET /apps/:appId/flags` route. The direct route authenticates the
product's exact config domain with its domain-hash credential, binds the opaque
active App to that registered domain, requires active UOA organisation
membership and an exact active team membership when `teamId` is present, then
returns a private/no-store flat boolean map. Cross-domain, inactive, missing,
or mismatched state returns `{}` without enumeration. Runtime product
capabilities require explicit `true` and fail closed on every other result.

`POST /billing/v1/service-access/confirm` is the mandatory direct-session seam:
each product backend calls it immediately after its own successful UOA SSO
exchange with that product's lifecycle key and actor. UOA rechecks active
organisation/team membership and records the exact product/team/user in one
repeatable-read transaction. Proxy or agent use of another product never calls
this route for the other product and remains indirect.

Cancellation state loads only active, non-revoked access for current
organisation/team members and active services, then selects another
subscription only when its exact service still has at least one such user and
its Stripe account matches the current subscription. The preview applies the
same check defensively before pinning IDs. Empty/revoked/stale evidence,
other-account rows, and Ledger-only attribution never create a related choice.

The Stripe boundary is an optional projection layer, disabled by default.
Checkout and lifecycle routes require a purpose-limited customer-lifecycle app
key plus the exact actor verification path, then
requires an active owner/admin at the selected organisation/team billing scope.
`billing-stripe-catalog.service.ts` maps immutable tariff versions to fixed and
metered Stripe Prices; `billing-stripe-webhook.service.ts` verifies the exact
raw body with a separate webhook secret and reconciles exact
customer/product/tariff/scope/item bindings against Stripe's current state.
Every projection is keyed to the exact Stripe account and API-key mode.
Checkout uses a recoverable scope lease and stable account/mode idempotency,
while a resulting subscription pins its immutable tariff source and assignment
until terminal. Org-wide live rows exclude team rows for the same product and
organisation; distinct team rows may coexist. Exact item cardinality, quantity,
and absence of discounts are fail-closed. The Ledger collector presents UOA's
own dedicated Ledger app key and a short-lived `metering.read` service
assertion. Its separate public verification overlap is served at
`/billing/v1/service-jwks.json`. For commercial rating and Stripe export, the
collector validates Ledger's immutable, product-scoped
`metering-usage-v1` response. For `BillingStatementV2` transparency it validates
one exact-team, user-grouped `metering-portfolio-v1` response with
`view=team_portfolio`; the asserted product is only the requesting
perspective. UOA derives the rating and all connected-service transparency
from that same pinned fact set. Both contracts contain raw provider usage,
estimated/actual cost, and the exact aggregate selected cost
`SUM(COALESCE(actual, estimated))`; they reject commercial fields. UOA alone
rates cumulative customer-money deltas before
sending them to Stripe's sum meter. None of these paths accepts another
product's app key, a user token, or a webhook secret as an app credential.
The safe summary omits Stripe IDs and remains available with an explicit
disabled flag from the last unambiguous local projection. Portal and
period-end cancellation require the exact billing manager and return-origin
policy. Cancellation is an opaque preview/confirm capability that pins exact
same-account direct subscriptions, revalidates under lock, and never promotes
Ledger-only indirect use into a cancellation choice. Checkout's no-proration
partial alignment period is free; complete
renewals are UTC calendar months. When the process gate is enabled,
`billing-stripe-scheduler.service.ts` repeatedly invokes the idempotent Ledger
snapshot export and installs an additional pre-boundary safety timer.
`billing-stripe-invoice.service.ts` owns the authoritative draft
subscription-cycle `invoice.created` post-period pass before webhook commit and
the structured `invoice.finalization_failed` handling. Free/manual/none plans
and the alignment stub are excluded, while unexpected period drift fails
visibly.

> SCIM is deferred. When implementation lands, add a `scim-auth` middleware (SCIM bearer token validation and org-scope verification for `/scim/v2/*`, returning 401 on invalid token and 403 on org scope mismatch) and update both this list and the directory tree.

### Services (fat)

- All business logic lives here
- Services call Prisma for database access
- Services call other services when needed (e.g. auth service calls password service)
- Each service file covers one domain of logic
- Social providers each get their own file, sharing a common base interface

### Utils

- Pure helper functions with no side effects
- No database access
- No external API calls

---

## File Size Rules

- **Maximum 500 lines per code file.** No exceptions.
- If a service grows past this, split by sub-concern. Two patterns are used in the tree today:
  - **Flow-level split** — peer files named for the sub-flow, e.g. `auth-login.service.ts`, `auth-register.service.ts`, `auth-reset-password.service.ts`.
  - **Domain slice split** — sibling `<domain>.service.<slice>.ts` files, optionally with an orchestration entry point. Two flavours in the tree today: `internal-admin.service.ts` is the entry point that re-exports from `internal-admin.service.base.ts`, `internal-admin.service.domains.ts`, `internal-admin.service.organisations.ts`, and `internal-admin.service.users.ts`; the `organisation.service.*` family uses no orchestration entry — callers import directly from `organisation.service.organisation.ts`, `organisation.service.members.ts`, or `organisation.service.base.ts`. Pick the form that fits the call sites.
- If a route file grows past this, split by endpoint.
- Tests have no line limit but should still be organized logically.

---

## Error Handling

- All errors thrown internally use structured error objects with codes
- The global error handler catches everything
- User-facing responses are always generic: `"Authentication failed"`, `"Request failed"`, etc.
- Internal logs include the full error with stack trace, context, and specifics
- Never return: "wrong password", "email exists", "2FA failed", "wrong provider", or any other specific reason

---

## Database Access

- **Prisma only** — no raw SQL unless absolutely necessary
- All queries go through services, never directly from routes
- Transactions used where atomicity matters (e.g. user creation + superuser assignment)
- Connection pooling handled by Prisma

---

## Testing

- Unit tests for all services
- Integration tests for all API endpoints
- Tests verify generic error responses (no leakage)
- Tests verify enumeration protection
- Test files live alongside what they test or in `/tests`
