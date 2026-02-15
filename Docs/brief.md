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

## 24. Organisations, Teams & Groups

### 24.1 Feature Gate & Configuration

Organisation, team, and group behaviour is opt-in via the config JWT claim `org_features`.

The claim is optional and defaults to disabled. The object shape and defaults are:

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

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Whether org/team features are enabled for this domain |
| `groups_enabled` | boolean | `false` | Whether groups are enabled (requires `enabled: true`) |
| `max_teams_per_org` | integer | `100` | Maximum teams per organisation (max 1000) |
| `max_groups_per_org` | integer | `20` | Maximum groups per organisation (max 200) |
| `max_members_per_org` | integer | `1000` | Maximum members per organisation (max 10000) |
| `max_members_per_team` | integer | `200` | Maximum members per team (max 5000) |
| `max_members_per_group` | integer | `500` | Maximum members per group (max 5000) |
| `max_team_memberships_per_user` | integer | `50` | Maximum teams a single user can belong to — also caps JWT size (max 200) |
| `org_roles` | string[] | `["owner", "admin", "member"]` | Allowed org-level roles. Must always contain `"owner"`. |

* `enabled = false` (or omitted): all `/org/*` and `/internal/org/*` endpoints return `404`, access tokens omit `org` claims.
* `groups_enabled = false`: group read/write paths return `404`.
* `org_roles` **must include `"owner"`** — Zod validation rejects configs without it.
* `max_*` values are enforced on write paths; invalid values reject the config.

Follow the same Zod pattern as `2fa_enabled` and `user_scope` in `ClientConfigSchema` — an optional field with defaults:

```typescript
org_features: z.object({
  enabled: z.boolean().default(false),
  groups_enabled: z.boolean().default(false),
  max_teams_per_org: z.number().int().positive().max(1000).default(100),
  max_groups_per_org: z.number().int().positive().max(200).default(20),
  max_members_per_org: z.number().int().positive().max(10000).default(1000),
  max_members_per_team: z.number().int().positive().max(5000).default(200),
  max_members_per_group: z.number().int().positive().max(5000).default(500),
  max_team_memberships_per_user: z.number().int().positive().max(200).default(50),
  org_roles: z.array(z.string().min(1).max(50)).refine(
    (roles) => roles.includes('owner'),
    { message: 'org_roles must include "owner"' }
  ).default(['owner', 'admin', 'member']),
}).optional().default({
  enabled: false, groups_enabled: false,
  max_teams_per_org: 100, max_groups_per_org: 20,
  max_members_per_org: 1000, max_members_per_team: 200,
  max_members_per_group: 500, max_team_memberships_per_user: 50,
  org_roles: ['owner', 'admin', 'member'],
})
```

#### Reserved Role: `"owner"`

The `"owner"` role has system-level semantics: only owners can delete organisations, transfer ownership, and change member roles. The `org_roles` array must always include `"owner"`.

`"owner"` and `"admin"` are the only system-interpreted roles for service-level permissions. All other role strings in `org_roles` are product-defined — stored and included in JWTs but carry no system-level permissions.

---

### 24.2 Database Schema

Add the following models to `API/prisma/schema.prisma`. Follow existing conventions: `cuid()` IDs, `snake_case` table/column mapping, `@@map()` on all models, `createdAt`/`updatedAt` timestamps.

#### Organisation

```prisma
model Organisation {
  id        String   @id @default(cuid())
  domain    String
  name      String   @db.VarChar(100)
  slug      String   @db.VarChar(120)
  ownerId   String   @map("owner_id")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  owner   User         @relation("OrgOwner", fields: [ownerId], references: [id], onDelete: Restrict)
  members OrgMember[]
  teams   Team[]
  groups  Group[]

  @@unique([domain, slug])
  @@index([domain])
  @@index([ownerId])
  @@map("organisations")
}
```

* `ownerId` is a direct reference to the owning user. `onDelete: Restrict` prevents deleting a user who owns an org — ownership must be transferred first.
* `slug` is URL-safe, unique per domain (see 24.4).

#### OrgMember

```prisma
model OrgMember {
  id        String   @id @default(cuid())
  orgId     String   @map("org_id")
  userId    String   @map("user_id")
  role      String   @default("member")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  org  Organisation @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([orgId, userId])
  @@index([userId])
  @@map("org_members")
}
```

* `role` is validated against `org_roles` config on write only. On read, return whatever is stored.
* `updatedAt` tracks role change timestamps.

#### Team

```prisma
model Team {
  id          String   @id @default(cuid())
  orgId       String   @map("org_id")
  groupId     String?  @map("group_id")
  name        String   @db.VarChar(100)
  description String?  @db.VarChar(500)
  isDefault   Boolean  @default(false) @map("is_default")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  org     Organisation @relation(fields: [orgId], references: [id], onDelete: Cascade)
  group   Group?       @relation(fields: [groupId], references: [id], onDelete: SetNull)
  members TeamMember[]

  @@unique([orgId, name])
  @@index([orgId])
  @@index([groupId])
  @@map("teams")
}
```

* If a group is deleted, its teams become ungrouped (`onDelete: SetNull`).
* `isDefault` marks the auto-created default team. One per org.

#### TeamMember

```prisma
model TeamMember {
  id        String   @id @default(cuid())
  teamId    String   @map("team_id")
  userId    String   @map("user_id")
  teamRole  String   @default("member") @map("team_role")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([teamId, userId])
  @@index([userId])
  @@map("team_members")
}
```

* `teamRole`: `lead` or `member`. Validated at application layer.

#### Group

```prisma
model Group {
  id          String   @id @default(cuid())
  orgId       String   @map("org_id")
  name        String   @db.VarChar(100)
  description String?  @db.VarChar(500)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  org     Organisation  @relation(fields: [orgId], references: [id], onDelete: Cascade)
  teams   Team[]
  members GroupMember[]

  @@unique([orgId, name])
  @@index([orgId])
  @@map("groups")
}
```

#### GroupMember

```prisma
model GroupMember {
  id        String   @id @default(cuid())
  groupId   String   @map("group_id")
  userId    String   @map("user_id")
  isAdmin   Boolean  @default(false) @map("is_admin")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  group Group @relation(fields: [groupId], references: [id], onDelete: Cascade)
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([groupId, userId])
  @@index([userId])
  @@map("group_members")
}
```

#### User Model Changes

Add relations to the existing `User` model:

```prisma
ownedOrgs     Organisation[] @relation("OrgOwner")
orgMembers    OrgMember[]
teamMembers   TeamMember[]
groupMembers  GroupMember[]
```

---

### 24.3 Organisation

* An organisation belongs to a **domain** and is the top-level tenant concept.
* A domain can have **multiple organisations**.
* A user belongs to **exactly one organisation** per domain (with global `user_scope`, the same person could belong to different orgs on different domains).
* The user who creates an organisation becomes its **owner** (tracked via `ownerId`).
* Every organisation has a **default team** created automatically at org creation time (see 24.5).
* Creating an org: in one transaction, create the org, add the creator as owner (`OrgMember` with role `"owner"`), and create the default "General" team with `isDefault: true`.

#### Owner-Only Operations

* Delete the organisation
* Transfer ownership (`POST /org/organisations/:orgId/transfer-ownership`)
* Change a member's org role

#### Ownership Transfer

`POST /org/organisations/:orgId/transfer-ownership` accepts `{ newOwnerId: string }`. In a transaction:

1. Verify `newOwnerId` is an existing org member.
2. Set `Organisation.ownerId` to the new owner.
3. Set the new owner's `OrgMember.role` to `"owner"`.
4. Set the old owner's `OrgMember.role` to `"admin"`.

#### User Removal Cascade

When removing a user from an org (`DELETE /org/organisations/:orgId/members/:userId`), the service must within the same transaction:

1. Delete all `TeamMember` records where the user belongs to teams in this org.
2. Delete all `GroupMember` records where the user belongs to groups in this org.
3. Delete the `OrgMember` record.

#### Sole Owner Deletion

`Organisation.ownerId` has `onDelete: Restrict`. A user who is the sole owner of an org cannot be deleted — ownership must be transferred first.

#### One Org Per User Per Domain

The `@@unique([orgId, userId])` on `OrgMember` only prevents duplicate membership within one org. To enforce one-org-per-user-per-domain:

* The service must query "does this user already belong to any org on this domain?" before adding them.
* This check runs inside the transaction that creates the `OrgMember` record.
* With `user_scope: "per_domain"`, this is naturally enforced (user records are domain-scoped). With `user_scope: "global"`, the check must be explicit.

#### Member Addition: No Email-Based Lookup

To prevent email enumeration (consistent with Section 11), the member addition endpoint accepts a **userId**, not an email. The consuming product looks up user IDs through its own means (e.g., the existing `/domain/users` endpoint). If the userId does not exist or does not belong to the domain, the endpoint returns a generic error.

---

### 24.4 Slug Rules

Organisation slugs are derived from the `name` field:

* **Allowed characters:** lowercase alphanumeric and hyphens (`[a-z0-9-]`)
* **Pattern:** `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/` (start and end with alphanumeric)
* **No consecutive hyphens**
* **Minimum length:** 2 characters
* **Maximum length:** 120 characters
* Unicode characters transliterated to ASCII before slugifying
* **Reserved slugs** that must be rejected: `admin`, `api`, `internal`, `me`, `system`, `settings`, `new`, `default`
* **Collision resolution:** append a random 4-character alphanumeric suffix (e.g., `my-org-a7f3`). Try up to 10 times, then fail. Do NOT use incrementing numeric suffixes (avoids leaking org count).
* Slugs are **regenerated** when the org name is updated via `PUT /org/organisations/:orgId`.

---

### 24.5 Team Semantics

* An org has many teams.
* Team constraints:
  * `name`: max 100 chars, unique within org
  * `description`: optional, max 500 chars
  * `isDefault`: boolean
* Team membership role is separate from org role:
  * Allowed values: `member` (default), `lead`
  * `lead` is a display/routing designation — not an access control role
* Every org member must belong to at least one team.
  * On org membership add, user is auto-added to the default team.

#### Default Team

* When an org is created, a team named "General" is auto-created with `isDefault: true`.
* When a user is added to an org, they are auto-added to the default team.
* The default team **cannot be deleted**.
* The default team can be renamed but `isDefault` cannot be changed.
* A user cannot be removed from their last team — remove them from the org instead.

#### Team Membership Constraints

* `max_members_per_team` from config
* `max_team_memberships_per_user` from config
* User cannot be removed from their final team membership
* Team CRUD restricted to owner/admin roles
* `PUT` on team **cannot change `isDefault` or `groupId`** — group assignment is internal-only

---

### 24.6 Group Semantics (Enterprise Option)

* Groups are optional — only active when `groups_enabled` is `true`.
* An org can have many groups; max is `max_groups_per_org`.
* A team belongs to **at most one group** (nullable — teams can be ungrouped).
* Group membership stores `is_admin` per user. This flag has no auth-level behaviour — it is persisted for consuming products.
* Group reads are available to any org member via the `/org/` API.
* **All group write operations are system-admin-only** — accessed through the Internal API (`/internal/org/`), not user-facing endpoints.

---

### 24.7 Access Token JWT Changes

When `org_features.enabled` is `true` and the user belongs to an org, the access token includes an `org` claim:

```json
{
  "sub": "user_abc",
  "email": "user@example.com",
  "domain": "app.example.com",
  "client_id": "hash_xyz",
  "role": "user",
  "org": {
    "org_id": "org_abc",
    "org_role": "admin",
    "teams": ["team_1", "team_2"],
    "team_roles": { "team_1": "lead", "team_2": "member" },
    "groups": ["group_a"],
    "group_admin": ["group_a"]
  },
  "iss": "unlike-other-authenticator",
  "iat": 1706742000,
  "exp": 1706745600
}
```

| Claim | Type | Description |
|---|---|---|
| `org.org_id` | string | Organisation ID |
| `org.org_role` | string | User's org role |
| `org.teams` | string[] | Team IDs (capped at `max_team_memberships_per_user`) |
| `org.team_roles` | object | Map of team_id to team role |
| `org.groups` | string[] | Group IDs (only when `groups_enabled`) |
| `org.group_admin` | string[] | Groups where user has `is_admin = true` |

* If user has no org on this domain, the `org` claim is **omitted entirely** (not null, not empty — absent).
* JWT size grows linearly with memberships. `max_team_memberships_per_user` (default: 50) caps this. With 50 teams and 20 groups, expect ~4-5KB additional payload. Consuming products may need to increase reverse proxy header buffer sizes.
* JWT `org` claims are populated at issuance time, not updated mid-session. Changes require re-authentication (consistent with Section 22.10).

#### Implementation

* Modify `signAccessToken()` in `token.service.ts`: add optional `org` parameter to the existing flat params.
* Modify `AccessTokenClaimsSchema` in `access-token.service.ts`: add optional `org` Zod schema. Update `AccessTokenClaims` type and the hand-mapped return in `verifyAccessToken()`.
* Modify `exchangeAuthorizationCodeForAccessToken()`: query org context via `org-context.service.ts` when `org_features.enabled`.

---

### 24.8 Authentication & Middleware

The `/org/` endpoints use a **dual-auth pattern**: domain hash token for backend identity + user access token for user identity.

#### Required on All `/org/` Endpoints

1. `?domain=<domain>` query parameter (same pattern as `/domain/*`)
2. `?config_url=<config_url>` query parameter (config verified on every request)
3. Domain hash bearer token in `Authorization` header

#### User Identity

For endpoints needing user context, the access token goes in `X-UOA-Access-Token` header (already redacted in Fastify logger config). The `Authorization` header carries the domain hash token.

#### Middleware Chain

```
Request
  → config-verifier.ts       (fetch & verify config, attach to request)
  → requireDomainHashAuthForDomainQuery  (verify Authorization bearer)
  → org-features.ts          (check config.org_features.enabled → 404 if disabled)
  → org-role-guard.ts        (extract X-UOA-Access-Token, verify, check org role)
  → Route handler
```

For org creation: `org-role-guard.ts` must not require an org role (user has no org yet). It only verifies the access token is valid and the domain matches.

#### Cross-Domain Validation (IDOR Prevention)

* `org-role-guard.ts` must verify the `domain` claim in the user's access token matches `?domain=`.
* Service layer must verify that any org in the URL path belongs to the `?domain=` domain.
* Every operation must verify the full ownership chain: domain → org → team/group → member.

#### Error Pattern

All errors use `AppError` from `utils/errors.ts`. The global error handler returns only `{ error: "Request failed" }`. No status-specific messages that leak information.

---

### 24.9 API Endpoints (User-Facing)

#### Organisation Management

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| POST | `/org/organisations` | Create org (auto-creates default team) | Any authenticated user (must not already belong to an org on this domain) |
| GET | `/org/organisations/:orgId` | Get org details | Any org member |
| PUT | `/org/organisations/:orgId` | Update org name/slug | Owner, Admin |
| DELETE | `/org/organisations/:orgId` | Delete org and all nested data | Owner only |
| GET | `/org/organisations/:orgId/members` | List org members (paginated) | Any org member |
| POST | `/org/organisations/:orgId/members` | Add user to org (by userId) | Owner, Admin |
| PUT | `/org/organisations/:orgId/members/:userId` | Change member's org role | Owner only |
| DELETE | `/org/organisations/:orgId/members/:userId` | Remove member (cascades team/group) | Owner, Admin (cannot remove last owner) |
| POST | `/org/organisations/:orgId/transfer-ownership` | Transfer ownership | Owner only |

#### Team Management

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| GET | `/org/organisations/:orgId/teams` | List teams (paginated) | Any org member |
| POST | `/org/organisations/:orgId/teams` | Create team | Owner, Admin |
| GET | `/org/organisations/:orgId/teams/:teamId` | Get team details + members | Any org member |
| PUT | `/org/organisations/:orgId/teams/:teamId` | Update name/description | Owner, Admin |
| DELETE | `/org/organisations/:orgId/teams/:teamId` | Delete team (not default) | Owner, Admin |
| POST | `/org/organisations/:orgId/teams/:teamId/members` | Add user to team | Owner, Admin |
| PUT | `/org/organisations/:orgId/teams/:teamId/members/:userId` | Change team role | Owner, Admin |
| DELETE | `/org/organisations/:orgId/teams/:teamId/members/:userId` | Remove from team (not last team) | Owner, Admin |

#### Group Management (Read-Only)

Returns `404` if `groups_enabled` is `false`.

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| GET | `/org/organisations/:orgId/groups` | List groups (paginated) | Any org member |
| GET | `/org/organisations/:orgId/groups/:groupId` | Get group details + teams + members | Any org member |

#### Domain Admin

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| GET | `/org/organisations` | List all orgs on domain (paginated) | Domain hash auth only |

#### User Context

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| GET | `/org/me` | Current user's org context | Any authenticated user |

Returns same structure as JWT `org` claim but always reflects current database state.

---

### 24.10 Internal API

Group management and team-to-group assignment are system-admin-only. System admins are backend services, not human users.

#### Authentication

1. `?domain=<domain>` query parameter
2. Domain hash bearer token in `Authorization` header
3. `?config_url=<config_url>` query parameter
4. **No user access token** — machine-to-machine calls

The domain hash token represents full system trust. Any backend possessing the shared secret is implicitly a system admin.

#### Middleware Chain

```
Request
  → config-verifier.ts                     (fetch & verify config)
  → requireDomainHashAuthForDomainQuery    (verify domain hash)
  → org-features.ts                        (check enabled)
  → groups-enabled.ts                      (check groups_enabled → 404 if disabled)
  → Route handler
```

No `org-role-guard.ts` — no user in the request.

#### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/internal/org/organisations/:orgId/groups` | Create group |
| PUT | `/internal/org/organisations/:orgId/groups/:groupId` | Update group |
| DELETE | `/internal/org/organisations/:orgId/groups/:groupId` | Delete group (teams become ungrouped) |
| POST | `/internal/org/organisations/:orgId/groups/:groupId/members` | Add group member |
| PUT | `/internal/org/organisations/:orgId/groups/:groupId/members/:userId` | Toggle is_admin |
| DELETE | `/internal/org/organisations/:orgId/groups/:groupId/members/:userId` | Remove group member |
| PUT | `/internal/org/organisations/:orgId/teams/:teamId/group` | Assign/unassign team to group |

#### Team-Group Assignment

`PUT /internal/org/organisations/:orgId/teams/:teamId/group` accepts `{ groupId: string | null }`. `null` ungroups the team. Must verify:

1. Team belongs to the org.
2. Group (if provided) belongs to the same org.
3. `groups_enabled` is `true`.

#### Security Note

The internal API must never be exposed to end users. In production, these endpoints should be network-restricted (VPC, API gateway). The authenticator does not enforce network-level restrictions.

---

### 24.11 Pagination & Rate Limiting

#### Pagination

All list endpoints support cursor-based pagination:

* Query parameters: `?limit=50&cursor=<last_id>`
* Response: `{ data: [...], next_cursor: "..." | null }`
* Default limit: 50, maximum: 200

#### Rate Limiting

Extend `rate-limiter.ts` for `/org/` routes:

* Org creation: 5 per user per domain per hour
* Member addition: 100 per org per hour
* Team creation: 50 per org per hour
* Read endpoints: standard API rate limits

---

### 24.12 Operational Lifecycle

#### Enabling on an Existing Domain

When `org_features` is enabled on a domain with existing users, none belong to an org. The authenticator does not migrate. The consuming product must:

1. Prompt users to create or join organisations.
2. Handle missing `org` JWT claim gracefully.
3. Optionally use the Internal API to pre-create orgs.

#### Disabling After Orgs Exist

Setting `enabled: false` hides all org endpoints (`404`) and omits `org` JWT claims. **Existing data is NOT deleted.** Re-enabling restores access. For permanent removal, delete orgs via API before disabling.

#### `org_roles` Config Changes

If `org_roles` changes and existing members have roles no longer in the list, those members retain their stored role. The consuming product must bulk-update roles if needed. Validation is write-only — the JWT contains whatever role is stored.

---

### 24.13 Constraints

1. **Completely generic.** No product-specific concepts.
2. **Backwards compatible.** Existing flows unchanged when `org_features` is absent.
3. **No admin dashboard.** API-only. No UI changes.
4. **No refresh tokens.** Re-authenticate for updated claims.
5. **Existing security rules apply.** Generic errors, no enumeration, no leakage.
6. **File size limit: 500 lines.**
7. **Follow existing code patterns.** See `token.service.ts`, `domain-role.service.ts`, `domain-hash-auth.ts`.
8. **Prisma only.** No raw SQL. Use transactions for multi-step mutations.
9. **Slug rules.** Random suffixes, not incrementing (see 24.4).
10. **Deletion cascades.** Org deletion cascades teams, groups, memberships. Team deletion cascades memberships (cannot delete default). Group deletion sets `groupId = null` on teams.
11. **`org_roles` must include `"owner"`.** Validated on write, not read.
12. **One org per user per domain.** Enforced at application layer.
13. **Every user in at least one team.** Auto-added to default team on join.
14. **Group writes are internal-only.** Via `/internal/org/`.
15. **Member addition by userId, not email.** No enumeration.
16. **IDOR prevention.** Verify full ownership chain: domain → org → team/group → member.

## 25. Task Breakdown by Phase

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
