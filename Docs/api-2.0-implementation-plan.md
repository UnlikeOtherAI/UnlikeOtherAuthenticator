# API 2.0 Implementation Plan

## 1. Purpose

This document is the implementation plan for the `api-2.0` branch.

It is not a product brief. It is the engineering plan for how to evolve the current auth service API into a more explicit 2.0 contract with:

- first-class config verification/debugging endpoints
- stronger machine-readable config documentation for LLM consumers
- user profile support for pronouns
- a clearer public API contract, error envelope, and rollout sequence

This plan is based on the current codebase state on branch `api-2.0`, cut from release tag `v0.0.0`.

## 2. Current Baseline

### 2.1 Existing Runtime

- API framework: Fastify
- Database: PostgreSQL via Prisma
- Auth mechanisms:
  - signed config JWTs fetched from `config_url`
  - domain-hash bearer token for backend-to-backend domain routes
  - auth access token for user-scoped org routes
- Existing route families:
  - `/`
  - `/llm`
  - `/health`
  - `/config/verify`
  - `/auth/*`
  - `/2fa/*`
  - `/i18n/get`
  - `/domain/*`
  - `/org/*`

### 2.2 Existing Prisma Models

Current persisted data already includes:

- `users`
- `domain_roles`
- `verification_tokens`
- `authorization_codes`
- `refresh_tokens`
- `login_logs`
- `organisations`
- `org_members`
- `teams`
- `team_members`
- `groups`
- `group_members`
- `team_invites`
- `access_requests`
- `ai_translations`
- `org_email_domain_rules`
- `team_custom_roles`
- `scim_tokens`
- `scim_group_mappings`

### 2.3 Existing Cross-Cutting Middleware

- `config-verifier.ts`
- `domain-hash-auth.ts`
- `org-role-guard.ts`
- `org-permission.ts`
- `team-permission.ts`
- `error-handler.ts`

These are the correct seam lines for 2.0. The 2.0 work should extend these rather than bypass them.

### 2.4 Existing Admin Template Baseline

The repository already contains admin UI templates in `Docs/Admin/`.

These are:

- `Docs/Admin/template-login.html`
- `Docs/Admin/template-folder.html`
- `Docs/Admin/template-admin.html`

For future admin implementation work:

- use `Docs/Admin/README.md` as the template-baseline source
- use `Docs/Admin/architecture-admin.md` as the canonical admin architecture source
- use `Docs/techstack.md` as the canonical admin stack source

## 3. 2.0 Goals

### 3.1 Primary Goals

1. Preserve the current successful auth flow behavior.
2. Make configuration validation observable and debuggable.
3. Make the root and `/llm` endpoints sufficient for LLM-driven integration.
4. Add user pronouns as a formal profile capability.
5. Standardize public API contracts, especially errors and machine-readable docs.

### 3.2 Non-Goals

- No destructive rewrite of working auth flows without migration strategy.
- No removal of existing documentation endpoints.
- No loosening of config JWT verification in production auth routes.
- No duplication of route logic across multiple versions unless compatibility requires it.

## 4. Versioning Strategy

### 4.1 Recommended Approach

Do not fork the entire runtime into a second Fastify app.

Use:

- one codebase
- one deployment artifact
- incremental 2.0 route/resource improvements
- explicit contract versioning only where shape changes are breaking

### 4.2 Route Versioning Policy

Use these rules:

- Keep stable existing routes when the wire contract is unchanged.
- Introduce `/v2/...` only for breaking response/request shape changes.
- Keep `/`, `/llm`, and `/health` unversioned because they describe the live service.
- Keep `/config/verify` unversioned because it is a debug/contract utility endpoint, not a product-specific business object.

### 4.3 Breaking vs Non-Breaking

Non-breaking:

- adding new fields to response payloads
- adding new optional request fields
- adding new endpoints
- strengthening `/llm` and `/` documentation
- extending the shared JSON error envelope with additive fields while keeping existing top-level compatibility

Breaking:

- renaming existing fields
- changing auth requirements for an existing route
- changing list envelope shape
- changing token exchange response semantics
- removing previously returned response shapes without a compatibility window

## 5. Shared API Conventions for 2.0

### 5.1 Error Envelope

The shared JSON error envelope should remain:

```json
{
  "error": "Request failed",
  "code": "CONFIG_SCHEMA_INVALID",
  "summary": "The configuration payload failed schema validation.",
  "details": ["ui_theme.colors.primary: Required"],
  "hints": ["Supply the full ui_theme.colors object."]
}
```

2.0 requirement:

- machine-consumable and developer-facing JSON failures use the shared formatter
- route-specific generic `{ error: "Request failed" }` payloads should be extended into the shared envelope without breaking strict consumers unexpectedly
- HTML auth flows may still render a debug page when appropriate
- machine-consumable routes always return structured JSON

Security boundary:

- user-facing auth flows must continue to return generic user-safe errors
- structured `code`, `summary`, `details`, and `hints` are for machine-consumable, developer-facing, and debug endpoints such as `/config/verify`, `/`, and `/llm`

Compatibility rule:

- if any existing machine consumer depends on the legacy generic-only payload shape, introduce the full envelope via additive rollout or versioning rather than silently removing the old contract
- treat payloads explicitly documented in `/` or `/llm` as strict public contracts that cannot be silently broken

### 5.2 Response Envelope Policy

Use these conventions consistently:

- list endpoints:
  - `{ data: [...], next_cursor: string | null }`
- single-resource endpoints:
  - top-level object, no extra wrapper
- command endpoints:
  - `{ ok: true }` or command-specific explicit payload
- validation/debug endpoints:
  - top-level result object with per-check breakdown

### 5.3 Auth Header Policy

- domain-only routes:
  - `Authorization: Bearer <sha256(domain + SHARED_SECRET)>`
- user-scoped org routes:
  - `X-UOA-Access-Token: <jwt>`
  - `Authorization: Bearer <sha256(domain + SHARED_SECRET)>` when the route is also domain/config-bound
- config-bound routes:
  - `config_url` query param unless the route intentionally accepts raw config input

Decision rule:

- treat an `/org/*` route as domain/config-bound when it operates inside a domain tenant context and the current route wiring applies both `requireDomainHashAuth*` and `requireOrgRole`
- in the current codebase, this means the existing `/org/*` family should keep its current dual-header model unless a route is explicitly redesigned and documented otherwise

## 6. Data Model Changes

### 6.1 User Model Additions

Add to `User`:

- `pronounsPreset` mapped to `pronouns_preset`
- `pronounsCustom` mapped to `pronouns_custom`

Recommended persisted shape:

- `pronouns_preset`: nullable string enum
- `pronouns_custom`: nullable varchar(120)

Recommended preset values:

- `he_him`
- `she_her`
- `they_them`
- `any_pronouns`
- `ask_me`
- `prefer_not_to_say`
- `custom`

### 6.2 User Validation Rules

- both fields nullable
- if `pronouns_preset = null`, `pronouns_custom = null`
- if `pronouns_preset = custom`, `pronouns_custom` is required and trimmed
- if `pronouns_preset != custom`, `pronouns_custom = null`
- reject empty custom values after trim

### 6.3 Prisma Migration Plan

Migration 1:

- add `pronouns_preset` nullable column to `users`
- add `pronouns_custom` nullable column to `users`

No backfill is required because both fields are nullable.

### 6.4 API Serialization Shape

Expose:

```json
{
  "id": "usr_123",
  "email": "user@example.com",
  "name": "Alex",
  "pronouns_preset": "they_them",
  "pronouns_custom": null,
  "pronouns_display": "they/them"
}
```

`pronouns_display` should be derived server-side to keep clients dumb.

## 7. Database Connection and Persistence Plan

### 7.1 Connection Lifecycle

Current model is correct:

- `createApp()` reads env
- Prisma connects on startup when `DATABASE_URL` exists
- Prisma disconnects on app close

2.0 requirement:

- keep one Prisma client singleton
- keep route handlers free of direct DB access
- keep all writes inside services

### 7.2 Transaction Policy

Transactions are required for:

- user creation + domain role assignment
- authorization code issuance + side effects
- refresh token rotation
- organisation creation + default team creation + owner membership creation
- invite acceptance
- access request approval
- profile updates only if they become multi-write operations

### 7.3 Query Ownership

Only services own Prisma queries.

Routes may:

- parse input
- call services
- map HTTP response codes if needed

Routes must not:

- call Prisma directly
- duplicate validation rules from services

## 8. Endpoint Plan

This section is the implementation inventory for 2.0. It includes current routes, changes, and new endpoints.

### 8.1 Contract and Discovery Endpoints

#### `GET /`

Purpose:

- root discovery document
- full live endpoint schema
- top-level config contract summary

Must include:

- service name
- version
- repository
- docs link
- config JWT documentation
- config verification endpoint documentation
- endpoint list

2.0 work:

- keep endpoint
- continue exposing all live routes
- add explicit user profile/pronouns contract once implemented

#### `GET /llm`

Purpose:

- machine-readable integration guide for LLMs

Must include:

- config JWT required/optional fields
- exact `ui_theme` contract
- common styling mistakes
- config verification endpoint usage
- auth integration sequence
- org/team/group endpoints
- user profile fields once added

2.0 work:

- keep this as the most explicit integration guide
- ensure styling docs are more concrete than prose alone
- include examples that are copy-pastable

#### `GET /health`

Purpose:

- basic liveliness check

2.0 work:

- no contract change
- optionally expand internally to include revision/build metadata in logs, not necessarily in response

### 8.2 Config Verification and Debug Endpoints

#### `POST /config/verify`

Purpose:

- validate config without running the full auth flow
- allow backend systems, local scripts, and LLMs to test config correctness

Accepted inputs:

- `config`
- `config_jwt`
- `config_url`
- optional `shared_secret`
- optional `auth_service_identifier`

Checks:

1. source selection
2. `config_url` fetch
3. JWT decode
4. signature validation using provided `shared_secret`
5. audience validation using provided or env auth service identifier
6. schema validation
7. domain-to-`config_url` hostname match

Required behavior:

- if the shared secret is wrong, say so explicitly
- if schema is valid but signature fails, report both facts distinctly
- if `config_url` fetch fails, do not fabricate later-stage failures
- if raw `config` is provided, skip signature/audience checks cleanly

2.0 additions:

- add optional `strict` mode later if needed for warnings vs failures
- add optional `include_normalized_config` if we want the parsed/defaulted config echoed back safely

#### Internal Shared Service

`config-debug.service.ts` should remain the single source for:

- request parsing
- stage execution
- issue aggregation
- normalized output

Do not duplicate config validation logic between:

- `config-verifier.ts`
- `/config/verify`
- `/llm`

### 8.3 Authentication Endpoints

#### `GET /auth`

Purpose:

- render auth UI using verified config

Inputs:

- `config_url`
- optional `redirect_url`

Dependencies:

- `config-verifier`
- auth UI service

2.0 work:

- no major route change
- ensure debug failures always align with `/config/verify` terminology

#### `POST /auth/login`

Purpose:

- email/password auth

Inputs:

- email
- password
- optional `remember_me`
- optional `request_access`

Outputs:

- auth code redirect info
- or 2FA challenge
- or access request pending state

2.0 work:

- keep response contract stable
- ensure profile hydration includes pronouns in any downstream `/org/me` or profile response where appropriate

#### `POST /auth/register`

Purpose:

- registration start

2.0 work:

- no pronouns input here yet
- keep enumeration-safe behavior
- future optional support:
  - carry draft profile metadata through verification token if product requires collection before verification

#### `POST /auth/verify-email`

Purpose:

- complete email verification

2.0 work:

- optionally allow profile metadata completion after verification in a separate endpoint instead of overloading this route

#### `POST /auth/token`

Purpose:

- exchange auth code or refresh token

2.0 work:

- no contract break unless moving to `/v2/auth/token`
- ensure access token claims can include enough user profile context if required, but avoid bloating JWTs

#### `POST /auth/revoke`

Purpose:

- revoke refresh token family

2.0 work:

- unchanged

#### `POST /auth/reset-password/request`
#### `POST /auth/reset-password`
#### `GET /auth/email/reset-password`
#### `GET /auth/email/link`
#### `GET /auth/email/twofa-reset`
#### `GET /auth/email/team-invite`
#### `GET /auth/email/team-invite/decline`
#### `GET /auth/email/team-invite-open/:inviteId.gif`

2.0 work:

- unchanged at contract level
- only ensure shared error shape and docs consistency

#### `GET /auth/social/:provider`
#### `GET /auth/callback/:provider`

2.0 work:

- unchanged at route level
- ensure provider-specific failures map into the shared debug vocabulary

### 8.4 Two-Factor Endpoints

#### `POST /2fa/verify`
#### `POST /2fa/reset/request`
#### `POST /2fa/reset`

2.0 work:

- no route changes required for pronouns/config work
- keep under existing auth + error conventions

### 8.5 Translation Endpoint

#### `GET /i18n/get`

Purpose:

- fetch translation payload for current config language

2.0 work:

- no route change
- ensure `/llm` documents translation fallback behavior clearly

### 8.6 Domain Endpoints

#### `GET /domain/users`

Purpose:

- list users for the configured domain

2.0 work:

- extend returned user shape to include profile fields needed by admin/integrator views:
  - `name`
  - `pronouns_preset`
  - `pronouns_custom`
  - `pronouns_display`
- keep auth as domain-hash bearer token

#### `GET /domain/logs`

2.0 work:

- unchanged

#### `GET /domain/debug`

Purpose:

- domain-level debugging endpoint gated by config

2.0 work:

- optionally include profile schema version and config contract version metadata
- should complement, not replace, `/config/verify`

### 8.7 Org and Membership Endpoints

#### `GET /org/me`

Purpose:

- current user org context

2.0 change:

- include user profile block:

```json
{
  "user": {
    "id": "usr_123",
    "email": "user@example.com",
    "name": "Alex",
    "pronouns_preset": "they_them",
    "pronouns_custom": null,
    "pronouns_display": "they/them"
  }
}
```

This is the safest place to introduce user-profile data without inventing an entirely separate client bootstrap endpoint.

#### Organisation CRUD

- `GET /org/organisations`
- `POST /org/organisations`
- `GET /org/organisations/:orgId`
- `PUT /org/organisations/:orgId`
- `DELETE /org/organisations/:orgId`
- `POST /org/organisations/:orgId/ownership-transfer`

2.0 work:

- no direct pronouns impact
- keep the existing `/org/*` auth model: user access token via `X-UOA-Access-Token` plus domain-hash bearer auth where the route is domain/config-bound
- keep default team creation transactional

#### Organisation Member CRUD

- `GET /org/organisations/:orgId/members`
- `POST /org/organisations/:orgId/members`
- `PUT /org/organisations/:orgId/members/:userId`
- `DELETE /org/organisations/:orgId/members/:userId`

2.0 change:

- member list responses should include user profile summary fields for admin UX:
  - `name`
  - `email`
  - `pronouns_preset`
  - `pronouns_custom`
  - `pronouns_display`

#### Team CRUD and Membership

- `GET /org/organisations/:orgId/teams`
- `POST /org/organisations/:orgId/teams`
- `GET /org/organisations/:orgId/teams/:teamId`
- `PUT /org/organisations/:orgId/teams/:teamId`
- `DELETE /org/organisations/:orgId/teams/:teamId`
- `POST /org/organisations/:orgId/teams/:teamId/members`
- `PUT /org/organisations/:orgId/teams/:teamId/members/:userId`
- `DELETE /org/organisations/:orgId/teams/:teamId/members/:userId`

2.0 change:

- team member listings should include the same user profile summary block
- do not store pronouns on memberships; pronouns belong to `User`

#### Team Invites

- `POST /org/organisations/:orgId/teams/:teamId/invitations`
- `GET /org/organisations/:orgId/teams/:teamId/invitations`
- `POST /org/organisations/:orgId/teams/:teamId/invitations/:inviteId/resend`

2.0 work:

- no change for pronouns
- ensure `/llm` documents invite payloads accurately

#### Access Requests

- `GET /org/organisations/:orgId/teams/:teamId/access-requests`
- `POST /org/organisations/:orgId/teams/:teamId/access-requests/:requestId/approve`
- `POST /org/organisations/:orgId/teams/:teamId/access-requests/:requestId/reject`

2.0 work:

- include requestor profile summary when available

#### Groups

- `GET /org/organisations/:orgId/groups`
- `GET /org/organisations/:orgId/groups/:groupId`

2.0 work:

- include member user profile summary fields in group detail

### 8.8 New User Profile Endpoints

This is the main 2.0 addition beyond config verification.

#### `GET /profile/me`

Purpose:

- fetch current authenticated user profile independent of org context

Auth:

- access token (`X-UOA-Access-Token`)

Response:

```json
{
  "id": "usr_123",
  "email": "user@example.com",
  "name": "Alex",
  "pronouns_preset": "they_them",
  "pronouns_custom": null,
  "pronouns_display": "they/them",
  "avatar_url": "https://...",
  "twofa_enabled": true,
  "created_at": "2026-04-08T12:00:00.000Z"
}
```

#### `PATCH /profile/me`

Purpose:

- update mutable user profile fields

Auth:

- access token

Body:

- `name?`
- `pronouns_preset?`
- `pronouns_custom?`

Rules:

- partial update supported
- pronoun validation rules enforced centrally
- audit log optional later, not required for first implementation

Why separate profile route:

- avoids overloading `/org/me`
- decouples user identity from org placement
- gives client apps a stable user-profile API

### 8.9 Internal Admin Endpoints

The architecture doc already anticipates `/internal/admin/*`, but this route family is not yet present in the current root schema.

2.0 plan:

- do not implement all internal admin routes in the same first pronouns/config milestone
- once profile support exists, internal admin user/member responses should also include pronouns summary

### 8.10 Admin Panel Architecture Alignment

The admin panel implementation is not a blank-sheet design task.

Implementation rules:

- use `Docs/Admin/README.md` for the template baseline
- use `Docs/Admin/architecture-admin.md` for the admin architecture rules
- use `Docs/techstack.md` for stack and environment rules
- keep the admin panel under strict linting and strict TypeScript rules from the first commit

### 8.11 Existing `/config/verify` Endpoint

`/config/verify` already exists in the current API surface.

2.0 work extends this route; it does not introduce a separate replacement endpoint.

The expected 2.0 changes are:

- broader accepted input forms
- clearer staged validation output
- more explicit machine-readable failure reasons
- stronger documentation in `/` and `/llm`

## 9. Service Plan

### 9.1 New or Extended Services

#### `profile.service.ts`

New service.

Responsibilities:

- fetch current user profile
- validate and update profile fields
- derive `pronouns_display`

Internal methods:

- `getCurrentProfile(userId, deps?)`
- `updateCurrentProfile(userId, input, deps?)`
- `normalizePronouns(input)`
- `formatPronounsDisplay(record)`

#### `config-debug.service.ts`

Already present and should remain the config debug orchestration point.

Responsibilities:

- source selection
- fetch/decode/verify/schema/domain checks
- issue aggregation

#### Existing services to extend

- `org-context.service.ts`
  - include profile summary in `/org/me`
- `domain-users.service.ts`
  - include pronouns summary in domain user listings
- organisation/team/group services
  - include profile summary in member collections

## 10. Middleware Plan

### 10.1 Keep Existing Config Verifier

`config-verifier.ts` remains the gate for production auth-bound routes.

Do not weaken it by allowing invalid signatures for normal auth operations.

### 10.2 Add Access-Token Middleware Reuse for Profile Endpoints

If existing `org-role-guard` is too org-specific, add a dedicated lightweight middleware:

- `access-token-auth.ts`

Responsibilities:

- validate user access token
- attach claims to request
- no org membership requirement

Use it for:

- `GET /profile/me`
- `PATCH /profile/me`

## 11. Root Documentation Plan

### 11.1 `GET /`

Must document:

- complete endpoint list
- config verification endpoint
- config JWT schema
- profile endpoints once added

### 11.2 `GET /llm`

Must document:

- exact `ui_theme` schema
- common style failures
- config verification workflows
- profile API contract
- pronouns field semantics
- example valid config payload
- example `/config/verify` request
- example `/profile/me` response

### 11.3 Documentation Reuse

Keep documentation literals centralized where possible.

Recommended pattern:

- `API/src/routes/root/config-docs.ts`
- `API/src/routes/root/profile-docs.ts`

Do not copy large schema prose between `/` and `/llm`.

## 12. Testing Plan

### 12.1 Unit Tests

Add tests for:

- pronouns normalization
- `custom` + `pronouns_custom` validation
- `pronouns_display` formatting
- profile update patch semantics
- config verification stage breakdown

### 12.2 Integration Tests

Add tests for:

- `GET /profile/me`
- `PATCH /profile/me`
- invalid pronouns combinations
- domain/org/team/group responses including profile summary
- `/` includes new profile endpoints
- `/llm` includes profile/pronouns docs

### 12.3 Regression Tests

Existing tests must continue to cover:

- no email enumeration
- config JWT integrity enforcement
- refresh token rotation
- 2FA gates
- org/team/group permissions

## 13. Rollout Sequence

### Phase 1: Contract and Docs

- finalize 2.0 route/resource decisions
- write `/` and `/llm` additions
- lock response examples
- define the rule that route changes update `/` and `/llm` in the same PR

### Phase 2: Persistence

- add Prisma fields for pronouns
- generate migration
- regenerate Prisma client

### Phase 3: Profile Service and Routes

- implement access-token-only middleware if needed
- add `profile.service.ts`
- add `GET /profile/me`
- add `PATCH /profile/me`

### Phase 4: Response Propagation

- extend `/org/me`
- extend `/domain/users`
- extend org/team/group member response shapes

### Phase 5: Contract Validation

- complete tests
- audit `/` and `/llm` for completeness after the earlier per-PR updates
- ensure root schema is fully in sync

### Phase 6: Staging Deployment

- deploy to non-production
- verify `/config/verify`
- verify auth flows still work
- verify profile updates persist

### Phase 7: Production Release

- merge `api-2.0`
- tag release candidate
- deploy
- verify health and targeted smoke tests

## 14. Risks and Mitigations

### Risk: Contract Drift Between `/`, `/llm`, and Actual Routes

Mitigation:

- update schema files in the same PR as route changes
- add integration tests asserting endpoint presence in root docs

### Risk: Pronouns Logic Duplicated Across Services

Mitigation:

- centralize in `profile.service.ts`
- expose `pronouns_display` from server

### Risk: Breaking Existing Consumers With Response Shape Changes

Mitigation:

- additive response changes first
- use `/v2/...` only when a wire contract truly changes

### Risk: Config Verification Endpoint Misused as Production Auth Shortcut

Mitigation:

- keep `/config/verify` separate from `config-verifier.ts`
- never let successful raw-config validation count as auth-route config trust

## 15. Deliverables

The 2.0 implementation is complete only when all of the following exist:

- Prisma migration for pronouns
- updated `User` model
- profile service
- `GET /profile/me`
- `PATCH /profile/me`
- `/org/me` profile block
- profile summary in member/list endpoints
- stable `/config/verify`
- expanded `/` docs
- expanded `/llm` docs
- updated endpoint schema
- unit + integration tests
- successful lint, typecheck, and full test run
- staging deploy verification
- documented browser-safe admin session contract before any production admin-panel auth implementation replaces the stub

## 16. Immediate Next Step

This section is a condensed vertical-slice recommendation after Phase 1 documentation lock.

The first implementation PR on `api-2.0` should be:

1. add Prisma pronouns fields
2. add `profile.service.ts`
3. add `GET /profile/me`
4. add `PATCH /profile/me`
5. extend `/llm` and `/` docs for profile fields
6. add tests

That yields a coherent vertical slice without mixing too many route families in one change.
