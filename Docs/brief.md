# Central OAuth & Auth Service — Full Build Brief

## 1. Purpose

Build a **centralized OAuth / authentication service** used by multiple products (4–5+), providing:

* Unified login across products
* Configurable branding, UI, and languages per client
* Multiple auth methods (email/password + social)
* Optional 2FA
* Secure, tamper-proof configuration
* Zero admin UI requirement for client onboarding

This service is **stateless where possible**, standards-based, and API-first.

> **Tech Stack:** For technology choices and project structure, see [techstack.md](./techstack.md).

---

## 2. Core Principles

* **Email is the canonical user identifier**
* **One user = one email**, regardless of login method
* **No email enumeration**
* **No public secrets**
* **All client config is signed and verified**
* **Everything UI-related is templated**
* **Everything is configurable externally**
* **OAuth server holds minimal state**
* **No avatars stored locally**
* **Tailwind-only UI**

---

## 3. Architecture Overview

### Components

1. **OAuth/Auth Server (Central)**

   * Issues tokens
   * Renders auth UI
   * Verifies config integrity
   * Handles users, passwords, 2FA
2. **Client Applications**

   * Generate signed config
   * Open OAuth popup
   * Receive auth result
3. **Email Service**

   * Verification
   * Password reset
   * Login/registration flow
4. **AI Translation Service**

   * Fallback for missing translations
   * Cached permanently after generation

---

## 4. Client Identification & Trust Model

### Client Identity

* Each client is identified by a **verified domain**
* The **hash of (domain + shared secret)** is the **client ID**
* First user on a new domain becomes **superuser**

### Shared Secret

* One **shared secret**
* Stored as:

  * Client backend environment variable
  * OAuth server environment variable
* Never exposed publicly

---

## 5. Config Delivery & Integrity

### Config Format

* Config is delivered as a **JWT**
* Payload contains **all configuration**
* JWT is signed using the shared secret

### Why JWT

* Payload = config
* Signature = tamper protection
* No separate hash field required

### Verification Flow

1. Client generates JWT config
2. OAuth server verifies JWT signature
3. If invalid → request rejected
4. If valid → config trusted

---

## 6. Config Contents (JWT Payload)

### Required

* `domain`
* `redirect_urls`
* `enabled_auth_methods`
* `ui_theme`
* `language_config`

### Optional

* `2fa_enabled`
* `debug_enabled`
* `allowed_social_providers`
* `user_scope` — `"global"` (default) or `"per_domain"`
* `org_features` — feature-gated organisations/teams/groups configuration (default: disabled)

---

## 7. UI & Theming

### Rendering

* OAuth UI is rendered server-side
* Fully Tailwind-based

### Customizable

* Colors
* Corner radii
* Button styles
* Card styles
* Typography
* Logo URL
* Layout density

### Theming Source

* All UI properties come **only from config**
* No hardcoded client styles

---

## 8. Language & i18n

### Language Config

* Either:

  * Single language (no selector)
  * Array of languages (dropdown enabled)

### Language Selection

* Defaults to language selected on client website
* Dropdown shown only if multiple languages provided
* Client passes the selected language via optional config claim: `language` (must be one of `language_config` when `language_config` is an array)

### Translation Fallback

1. Missing translation detected
2. Translation file sent to AI
3. AI returns translated version
4. Translation cached permanently
5. Used for all future requests

---

## 9. Authentication Methods

### Supported

* Email + Password
* Google
* Apple
* Facebook
* GitHub
* LinkedIn

### Enablement

* Controlled per-client via config
* Any combination allowed

### Account Unification

* All providers resolve to **email**
* Same email = same user
* Logging in via different providers merges automatically

---

## 10. Email & Password Auth

### Email

* Email is the username
* Always required

### Password Rules

* Minimum 8 characters
* At least:

  * 1 uppercase
  * 1 lowercase
  * 1 number
  * 1 special character (`-` allowed)

### Password Storage

* Standard secure hashing
* No plaintext ever stored

---

## 11. Registration & Enumeration Protection

### No Email Existence Checks

* API never reveals:

  * Whether email exists
  * Whether account is registered

### Registration Flow

* User submits email
* Always respond:

  > "We sent instructions to your email"
* Email determines next step:

  * Existing user → login link
  * New user → verification + set password
* **Email copy must remain generic**: subjects and body text must not explicitly indicate whether an account already exists (even though the backend sends different links depending on state)

---

## 12. Email Verification & Password Reset

### Tokens

* One-time
* Time-limited
* Stored hashed

### Flows

* Email verification
* Password reset
* Both use secure token validation

---

## 13. Two-Factor Authentication (Optional)

### Enablement

* Controlled via config (JWT)
* Config must be signed

### Method

* TOTP (Authenticator apps)

### Setup Flow

1. Generate user-specific secret
2. Generate `otpauth://` URI
3. Render QR code
4. User scans with Authenticator
5. Verify initial code
6. Mark 2FA enabled

---

## 14. Tokens & OAuth Output

### Returned to Client

* OAuth access token (JWT)

### Token Contains

* User ID
* Email
* Domain/client ID
* Role (superuser or normal)
* Expiry
* Claims

### Stateless

* No session storage required
* Token verification via signature

### Short-Lived

* Access tokens must be **short-lived** (see **22.10 Token Lifetimes**; e.g. 15–60 minutes)
* There are **no refresh tokens** — when the access token expires, the client must re-initiate the OAuth flow

---

## 15. User Model

### Fields

* `id`
* `email`
* `password_hash` (nullable for social-only)
* `name`
* `role` (superuser / user)
* `2fa_enabled`
* `2fa_secret` (encrypted)
* `created_at`

### Avatar

* **No avatar storage**
* Store only external avatar URL
* Update avatar URL on every login

---

## 16. Login Logging & Auditing

### Log Fields

* User ID
* Email
* Domain
* Timestamp
* Auth method
* IP (optional)
* User agent (optional)

### Access

* API endpoint
* Requires **domain hash token**

---

## 17. Domain-Scoped APIs

### Protected APIs

* List users for domain
* Get login logs
* Debug endpoints

### Authorization

* Requires token = hash(domain + secret)
* Verified server-side

---

## 18. Superuser Rules

* First user on a domain becomes superuser
* Superuser gets:

  * Debug access
  * Domain-level visibility
* No global admin UI required

---

## 19. Security Summary

* Shared secret never exposed
* All configs signed (JWT)
* Domain verification required
* No enumeration vectors
* Stateless tokens
* Short-lived secrets
* Standard crypto primitives only

---

## 20. Non-Goals (Explicit)

* No admin dashboard
* No local avatar storage
* No per-client OAuth secrets
* No user-visible error specificity
* No unsiged configs accepted

---

## 21. Output of This System

* Reusable OAuth popup
* One auth backend for all products
* Config-driven UI + security
* Minimal operational overhead
* Scales horizontally

---

## 22. Clarifications & Constraints

The following tighten ambiguities in the brief to prevent misinterpretation during implementation.

---

### 22.1 Config URL Fetching & Trust Boundary

* The OAuth entrypoint **always starts with a config URL fetch**
* The client provides a URL pointing to the signed JWT config
* The auth server fetches the config from that URL, verifies it, then proceeds
* Config is **never** POSTed directly, embedded in query params, or stored centrally on the auth server

---

### 22.2 JWT Audience / Issuer Expectations

* The config JWT is used for **config delivery only** — it is not a user token
* Expected `aud`: the auth service identifier
* `exp` is **optional** on config JWTs (configs are verified on every request, not cached by trust)
* Config JWTs signed for one service **must not** be accepted by another
* Do not reuse user-token validation rules for config JWTs — they are separate concerns

---

### 22.3 Shared Secret Scope

* There is a **single global shared secret** for all clients
* There are **no per-client secrets**
* There is **no secret rotation UI**
* There are **no storage tables for secrets**
* The secret lives exclusively in environment variables on both the client backend and the auth server

---

### 22.4 Domain Verification Timing

* Domain verification is **deterministic and repeatable**
* It happens **on each auth initiation** — not once, not async, not cached
* There is no persistence of "verified domains"
* There is no retry logic or admin approval flow
* The domain is verified by checking the JWT config signature and matching the `domain` claim

---

### 22.5 Superuser Race Condition

* The first **successfully created** user row for a domain wins superuser status
* Race conditions are resolved at the **DB constraint level** (unique constraint, first insert wins)
* No locking, queues, or moderation flows
* Superuser assignment applies regardless of whether the first login is via social or email/password

---

### 22.6 Social Login Email Trust

* Only **provider-verified emails** are accepted from social login providers
* If a social provider returns an unverified email, the login is **rejected**
* This prevents account takeover via unverified email claims

---

### 22.7 Avatar Update Policy

* The stored avatar URL is **overwritten on every login** with the latest from the provider
* No avatar history is kept
* No fallback storage
* No caching policy — the URL is simply stored and served as-is

---

### 22.8 Login Logs Retention

* Login log retention is **implementation-defined, but must be finite**
* No infinite retention
* No GDPR deletion workflows required at this stage
* A reasonable default (e.g. 90 days) should be configured and documented

---

### 22.9 2FA Recovery / Reset

* There are **no backup codes**
* There are **no admin overrides** for 2FA
* There are **no support workflows** for lost devices
* The only recovery path is **email-based 2FA reset**: user verifies email ownership, then 2FA is disabled so they can re-enroll

---

### 22.10 Token Lifetimes

* Access token TTL: **implementation-defined, short-lived** (e.g. 15–60 minutes)
* There are **no refresh tokens** — explicitly excluded
* There is **no silent reauth**
* There is **no token rotation**
* When the access token expires, the client must re-initiate the OAuth flow

---

### 22.11 Error Handling Philosophy

* **All auth failures return generic user-facing errors**
* The system must never leak:
  * "2FA failed"
  * "Wrong provider"
  * "Email already exists"
  * "Invalid password"
  * Or any other specific failure reason
* Internal logs may contain specifics; user-facing responses must not
* A single generic message such as "Authentication failed" is used for all error cases

---

### 22.12 User Scope

* The `user_scope` config property controls whether users are **global** or **per-domain**
* Default: `"global"`
* **Global** (`"global"`):
  * One user = one email across all domains
  * Password, 2FA, and profile are shared
  * Roles (superuser / user) are **per-domain** — a user can be superuser on domain A and normal on domain B
  * Logging into a new domain with an existing email reuses the same account
* **Per-domain** (`"per_domain"`):
  * Users are scoped to the domain they registered on
  * The same email on two different domains creates two separate user records
  * Password, 2FA, and profile are independent per domain
  * No cross-domain account sharing

---

### 22.13 OAuth Flow Type

* The OAuth flow uses the **authorization code flow**
* The popup redirects back to the client with a **code**
* The client backend exchanges the code for an access token (JWT)
* This is the standard, more secure approach
* The token is **never** returned directly to the frontend via the popup
* Clients must have a backend callback endpoint to complete the exchange
* The code exchange endpoint must require backend-only authorization (derived from the shared secret)

---

**This brief is the single source of truth for implementation.**

---

## Organisations, Teams & Groups

### Config Feature Gate

Org, team, and group capabilities are optional and controlled by an optional `org_features` claim in the config JWT.

```json
"org_features": {
  "enabled": false,
  "groups_enabled": false,
  "max_teams_per_org": 100,
  "max_groups_per_org": 20,
  "max_members_per_org": 1000,
  "max_members_per_team": 200,
  "max_members_per_group": 500,
  "max_team_memberships_per_user": 50,
  "org_roles": ["owner", "admin", "member"]
}
```

### Rules

* `enabled` gates all `/org/*` and `/internal/org/*` API access (`false` returns 404).
* `groups_enabled` gates group-specific operations.
* `org_roles` must include `"owner"` and is used to validate org roles on write operations.
* `max_*` values cap organisation, team, group, and membership counts enforced at write time.

## 23. Task Breakdown by Phase

Each task references the line number(s) where the relevant specification lives in this document.

---

### Phase 1: Project Foundation & Core Server

| #  | Task | Ref (line) |
|----|------|------------|
| 1.1 | Initialize project repository, package manager, and base dependencies | L5–16 |
| 1.2 | Set up server framework (API-first, stateless) | L16, L29 |
| 1.3 | Set up environment variable loading for shared secret | L70–77 |
| 1.4 | Create base project folder structure | L35–58 |
| 1.5 | Set up database connection and migration system | L301–312 |
| 1.6 | Add health check endpoint | L16 |

---

### Phase 2: Config & Client Trust

| #  | Task | Ref (line) |
|----|------|------------|
| 2.1 | Implement client ID generation: hash(domain + shared secret) | L66–67 |
| 2.2 | Build config URL fetcher — auth entrypoint fetches JWT from client-provided URL | L405–410 |
| 2.3 | Implement JWT config signature verification using shared secret | L85–100 |
| 2.4 | Validate required config fields: `domain`, `redirect_urls`, `enabled_auth_methods`, `ui_theme`, `language_config` | L106–112 |
| 2.5 | Parse optional config fields: `2fa_enabled`, `debug_enabled`, `allowed_social_providers`, `user_scope` | L114–119 |
| 2.6 | Enforce `aud` claim on config JWT (must match auth service identifier) | L414–420 |
| 2.7 | Reject unsigned or tampered config JWTs | L98–100 |
| 2.8 | Validate `domain` claim matches the origin of the request | L434–440 |

---

### Phase 3: User Model & Database

| #  | Task | Ref (line) |
|----|------|------------|
| 3.1 | Create users table: `id`, `email`, `password_hash`, `name`, `role`, `2fa_enabled`, `2fa_secret`, `created_at` | L303–312 |
| 3.2 | Add `avatar_url` column (external URL only, no local storage) | L314–318 |
| 3.3 | Implement global user scope (default): one email = one user across all domains | L516–520 |
| 3.4 | Implement per-domain user scope: users isolated per domain, same email = separate records | L521–525 |
| 3.5 | Create domain-roles table for per-domain role assignment (superuser / user) | L309, L519 |
| 3.6 | Implement superuser assignment: first successfully created user row per domain wins | L68, L356–363, L444–449 |
| 3.7 | Ensure superuser race condition resolved at DB constraint level | L446–447 |

---

### Phase 4: Email & Password Authentication

| #  | Task | Ref (line) |
|----|------|------------|
| 4.1 | Implement password validation rules: min 8 chars, 1 upper, 1 lower, 1 number, 1 special char | L202–210 |
| 4.2 | Implement secure password hashing (bcrypt/argon2) | L212–215 |
| 4.3 | Build registration endpoint with enumeration protection — always respond "We sent instructions to your email" | L219–237 |
| 4.4 | Implement email-determines-next-step logic: existing user gets login link, new user gets verification + set password | L234–237 |
| 4.5 | Build login endpoint (email + password) with generic error responses | L195–215, L498–508 |
| 4.6 | Ensure API never reveals whether an email exists | L221–226 |

---

### Phase 5: Email Verification & Password Reset

| #  | Task | Ref (line) |
|----|------|------------|
| 5.1 | Generate one-time, time-limited tokens for email verification | L243–247 |
| 5.2 | Store tokens hashed (never plaintext) | L247 |
| 5.3 | Build email verification flow: token sent, user clicks, email confirmed | L251 |
| 5.4 | Build password reset flow: token sent, user clicks, sets new password | L252 |
| 5.5 | Implement secure token validation (one-time use, expiry check) | L253 |

---

### Phase 6: OAuth Authorization Code Flow

| #  | Task | Ref (line) |
|----|------|------------|
| 6.1 | Build OAuth entrypoint: accept config URL, fetch and verify config, render auth UI | L405–410 |
| 6.2 | Implement authorization code generation after successful authentication | L529–536 |
| 6.3 | Build token exchange endpoint: client backend sends code, receives access token JWT | L532–533 |
| 6.4 | Generate access token JWT containing: user ID, email, domain/client ID, role, expiry, claims | L285–292 |
| 6.5 | Enforce short-lived access token TTL (configurable, e.g. 15–60 min) | L488–494 |
| 6.6 | Validate `redirect_urls` from config before redirecting | L109 |
| 6.7 | Ensure token is never returned directly to frontend — code exchange only | L535 |
| 6.8 | No refresh tokens, no silent reauth, no token rotation | L491–494 |

---

### Phase 7: Social Authentication Providers

| #  | Task | Ref (line) |
|----|------|------------|
| 7.1 | Implement Google OAuth login | L176 |
| 7.2 | Implement Apple OAuth login | L177 |
| 7.3 | Implement Facebook OAuth login | L178 |
| 7.4 | Implement GitHub OAuth login | L179 |
| 7.5 | Implement LinkedIn OAuth login | L180 |
| 7.6 | Enforce provider-verified email only — reject unverified emails | L453–457 |
| 7.7 | Implement account unification: same email = same user, auto-merge across providers | L187–191 |
| 7.8 | Enable/disable providers per-client based on config `allowed_social_providers` | L118, L182–185 |
| 7.9 | Overwrite avatar URL on every social login | L317–318, L461–466 |

---

### Phase 8: Two-Factor Authentication

| #  | Task | Ref (line) |
|----|------|------------|
| 8.1 | Generate user-specific TOTP secret | L270 |
| 8.2 | Generate `otpauth://` URI from secret | L271 |
| 8.3 | Render QR code for authenticator app scanning | L272 |
| 8.4 | Verify initial TOTP code during setup | L274 |
| 8.5 | Mark 2FA as enabled on user record, store encrypted secret | L275, L310–311 |
| 8.6 | Enforce 2FA verification during login when enabled | L257–262 |
| 8.7 | 2FA enablement controlled per-client via config `2fa_enabled` | L116, L259–262 |
| 8.8 | Implement email-based 2FA reset (no backup codes, no admin override) | L479–484 |

---

### Phase 9: UI & Theming

| #  | Task | Ref (line) |
|----|------|------------|
| 9.1 | Set up server-side rendering for auth UI | L127 |
| 9.2 | Integrate Tailwind CSS (only CSS framework allowed) | L128, L31 |
| 9.3 | Build theme engine: apply colors, radii, button styles, card styles, typography, logo, density from config | L130–138 |
| 9.4 | Ensure all UI properties come only from config — no hardcoded client styles | L140–143 |
| 9.5 | Build login form template | L127 |
| 9.6 | Build registration form template | L228–237 |
| 9.7 | Build password reset form template | L252 |
| 9.8 | Build 2FA setup screen (QR code display + code input) | L268–275 |
| 9.9 | Build 2FA verification screen (code input during login) | L257–262 |
| 9.10 | Build OAuth popup container and redirect handling | L391, L529–536 |

---

### Phase 10: Language & i18n

| #  | Task | Ref (line) |
|----|------|------------|
| 10.1 | Build translation file structure (key-value per language) | L147–159 |
| 10.2 | Implement single-language mode (no selector shown) | L153 |
| 10.3 | Implement multi-language mode with dropdown selector | L154, L159 |
| 10.4 | Default to language selected on client website | L158 |
| 10.5 | Build AI translation fallback: detect missing translation, send to AI, receive result | L161–167 |
| 10.6 | Cache AI-generated translations permanently | L166 |
| 10.7 | Serve cached translations for all future requests | L167 |

---

### Phase 11: Email Service

| #  | Task | Ref (line) |
|----|------|------------|
| 11.1 | Set up email sending infrastructure (provider abstraction) | L50–54 |
| 11.2 | Build email verification email template | L52 |
| 11.3 | Build password reset email template | L53 |
| 11.4 | Build login link email template (for existing users during registration flow) | L54, L236 |
| 11.5 | Build 2FA reset email template | L479–484 |
| 11.6 | Ensure all emails use generic language — no information leakage | L221–226, L498–508 |

---

### Phase 12: Domain-Scoped APIs & Logging

| #  | Task | Ref (line) |
|----|------|------------|
| 12.1 | Implement login logging: user ID, email, domain, timestamp, auth method, IP, user agent | L324–332 |
| 12.2 | Build login logs API endpoint (requires domain hash token) | L334–337 |
| 12.3 | Build list-users-for-domain API endpoint | L345 |
| 12.4 | Build debug endpoints (superuser only) | L347, L359–362 |
| 12.5 | Implement domain hash token authorization: token = hash(domain + secret) | L349–352 |
| 12.6 | Enforce finite log retention (configurable, e.g. 90 days default) | L470–475 |

---

### Phase 13: Security Hardening & Final Validation

| #  | Task | Ref (line) |
|----|------|------------|
| 13.1 | Audit all endpoints for email enumeration vectors — ensure none leak | L24, L221–226 |
| 13.2 | Audit all error responses — ensure all are generic to user | L498–508 |
| 13.3 | Verify shared secret is never exposed in responses, logs, or client-side code | L25, L369 |
| 13.4 | Verify all config JWTs are rejected if unsigned or tampered | L370, L385 |
| 13.5 | Verify domain verification runs on every auth initiation | L434–440 |
| 13.6 | Verify social login only accepts provider-verified emails | L453–457 |
| 13.7 | Verify access tokens are stateless and short-lived | L294–297, L488–494 |
| 13.8 | Verify no refresh tokens, backup codes, or admin overrides exist | L379–385, L491, L480–482 |
| 13.9 | Verify avatar URL overwrite behavior (no history, no local storage) | L461–466 |
| 13.10 | End-to-end test: full OAuth flow from config URL fetch through token exchange | L405–410, L529–536 |
