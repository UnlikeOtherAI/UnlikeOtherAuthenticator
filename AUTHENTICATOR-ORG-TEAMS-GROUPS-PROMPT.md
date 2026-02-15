# Prompt: Add Organisations, Teams, and Groups to UnlikeOtherAuthenticator

> **This is a prompt to give to an LLM working on the UnlikeOtherAuthenticator repository.**
> It should be handed over as a complete brief. The LLM should update `Docs/brief.md`, the Prisma schema, architecture docs, services, routes, and tests accordingly.

---

## Context

You are working on [UnlikeOtherAuthenticator](https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator) — a centralized OAuth/authentication service used by multiple products (4–5+). Read `CLAUDE.md`, `Docs/brief.md`, `Docs/architecture-api.md`, `Docs/architecture-auth.md`, and `Docs/techstack.md` before doing anything.

The service currently handles:
- User registration and login (email/password + social providers)
- OAuth authorization code flow with short-lived JWT access tokens
- Per-domain roles (SUPERUSER / USER)
- Optional 2FA (TOTP)
- Config-driven theming and i18n

**What's missing:** The service has no concept of organisations, teams, or groups. Users exist as flat entities with per-domain roles. Every product that consumes this service needs a way to organise users into **teams** (a working group of people) and optionally **groups** (a collection of teams for enterprise customers). Since this is a shared service, these concepts must be **completely generic** — no product-specific business logic.

---

## What You're Building

Add three new organisational concepts to the authenticator:

### 1. Organisation

An **organisation** is a tenant — a company, business, or entity that has users. It is the top-level grouping.

- An organisation belongs to a **domain** (the client domain that created it).
- A domain can have **multiple organisations** (e.g., a SaaS product where many companies sign up).
- A user belongs to **exactly one organisation** per domain (but with global user_scope, the same person could belong to different orgs on different domains).
- The user who creates an organisation becomes its **owner** (tracked via `ownerId` on the Organisation model — see schema below).
- Every organisation has a **default team** created automatically at org creation time (see "Default Team" below).

### 2. Team

A **team** is a named group of users within an organisation.

- An organisation can have **many teams**.
- A user can be a member of **multiple teams** within their organisation (up to `max_team_memberships_per_user`).
- **Every user in an org must belong to at least one team.** When a user joins an org, they are automatically added to the org's default team.
- Each team membership carries a **team role**: `lead` or `member`.
  - `lead` is a display/routing designation — not an access control role. Products can use it to decide who receives escalations, who appears first in lists, etc.
  - `member` is the default.
- Teams have a name (max 100 characters) and an optional description (max 500 characters).

#### Default Team

- When an organisation is created, a team named "General" is automatically created and flagged as `isDefault: true`.
- When a user is added to an org, they are automatically added to the default team.
- The default team **cannot be deleted** (the service must prevent deletion of any team where `isDefault` is `true`).
- The default team can be renamed but the `isDefault` flag cannot be changed.
- A user cannot be removed from their last team — they must be removed from the org instead.

### 3. Group

A **group** is a named collection of teams within an organisation, for enterprise customers who need a layer between the org and individual teams.

- An organisation can have **many groups**.
- A team belongs to **at most one group** (nullable — teams can be ungrouped).
- Users can be assigned as **group members** with an optional `is_admin` flag.
  - A group admin can see aggregate data across all teams in the group (product-specific — the authenticator just stores the flag).
- Groups are **opt-in** via the config JWT (see below).
- **Group write operations (create, update, delete, member management, team-to-group assignment) are system-admin-only** — they are accessed through the Internal API using signed requests, not through user-facing endpoints. See the "Internal API" section below.
- Group read operations (list groups, get group details) are available to any org member through the standard `/org/` API.

---

## Feature Gating via Config JWT

These features must be opt-in per client domain. Add a new **optional** claim to the config JWT payload.

Follow the same pattern as `2fa_enabled` and `user_scope` in `ClientConfigSchema` — an optional field with a default value. Do NOT follow the `ui_theme` pattern (which is required).

```
"org_features": {
  "enabled": true,
  "groups_enabled": true,
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
| `max_teams_per_org` | integer | `100` | Maximum teams per organisation |
| `max_groups_per_org` | integer | `20` | Maximum groups per organisation |
| `max_members_per_org` | integer | `1000` | Maximum members per organisation |
| `max_members_per_team` | integer | `200` | Maximum members per team |
| `max_members_per_group` | integer | `500` | Maximum members per group |
| `max_team_memberships_per_user` | integer | `50` | Maximum teams a single user can belong to (also caps JWT size) |
| `org_roles` | string[] | `["owner", "admin", "member"]` | Allowed org-level roles. Must always contain `"owner"` (see below). Products can add custom roles. |

### Reserved Role: `"owner"`

The `"owner"` role has system-level semantics: only owners can delete organisations, transfer ownership, and change member roles. The `org_roles` array **must always include `"owner"`**. Zod validation must reject any config where `org_roles` does not contain `"owner"`.

Additional roles beyond `"owner"` are product-defined. The authenticator interprets `"owner"` and `"admin"` as having management permissions (see API endpoint tables). All other role strings are stored and included in JWTs but carry no system-level permissions — their meaning is up to the consuming product.

### Validation

When `org_features.enabled` is `false` (or omitted), all org/team/group endpoints return `404` and the JWT contains no org claims. The existing auth flow is completely unchanged.

When validating the config JWT, the `org_features` object should be parsed with Zod:

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

Invalid values should reject the config.

---

## Database Schema Changes (Prisma)

Add the following models to `API/prisma/schema.prisma`. Follow existing conventions: `cuid()` IDs, `snake_case` table/column mapping, `@@map()` on all models, `createdAt`/`updatedAt` timestamps.

### Organisation

```prisma
model Organisation {
  id          String   @id @default(cuid())
  domain      String
  name        String   @db.VarChar(100)
  slug        String   @db.VarChar(120)
  ownerId     String   @map("owner_id")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

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

- `slug` is a URL-safe identifier derived from `name`, unique per domain (see Slug Rules below).
- `domain` ties the org to the client domain.
- `ownerId` is a direct reference to the user who owns the org. Ownership transfer updates this field. The `onDelete: Restrict` prevents deleting a user who owns an org — ownership must be transferred first.

### OrgMember

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

- `role` is a free-text string validated against the `org_roles` list from config **on write operations only**. On read, return whatever is stored. If a role is removed from the config, existing members retain their stored role until explicitly changed.
- Default roles: `owner`, `admin`, `member`. Products can add custom role names via config.
- There must be at least one `owner` per org. The service must prevent removing the last owner.
- `updatedAt` is included so role changes are timestamped.

### Team

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

- Team names are unique within an org.
- `groupId` is nullable — teams can be ungrouped.
- If a group is deleted, its teams become ungrouped (`onDelete: SetNull`).
- `isDefault` marks the auto-created default team. Each org has exactly one default team.

### TeamMember

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

- `teamRole` is `lead` or `member`. Validated at the application layer.
- A user can only appear once per team.
- `updatedAt` is included so role changes are timestamped.

### Group

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

### GroupMember

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

- `updatedAt` is included so `is_admin` changes are timestamped.

### User model changes

Add relations to the `User` model:

```prisma
ownedOrgs     Organisation[] @relation("OrgOwner")
orgMembers    OrgMember[]
teamMembers   TeamMember[]
groupMembers  GroupMember[]
```

---

## Slug Rules

Organisation slugs are derived from the `name` field:

- **Allowed characters:** lowercase alphanumeric and hyphens (`[a-z0-9-]`)
- **Pattern:** `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/` (must start and end with alphanumeric)
- **No consecutive hyphens** (e.g., `my--org` is invalid)
- **Minimum length:** 2 characters
- **Maximum length:** 120 characters
- Unicode characters are transliterated to ASCII before slugifying
- **Reserved slugs** that must be rejected: `admin`, `api`, `internal`, `me`, `system`, `settings`, `new`, `default`
- **Collision resolution:** If the derived slug already exists on the domain, append a random 4-character alphanumeric suffix (e.g., `my-org-a7f3`). Try up to 10 times, then fail. Do NOT use incrementing numeric suffixes (to avoid leaking org count information).
- Slugs are **regenerated** when the org name is updated via `PUT /org/organisations/:orgId`.

---

## Access Token JWT Changes

When `org_features.enabled` is `true` and the user belongs to an organisation on the current domain, the access token JWT must include additional claims.

**Current JWT claims:**

```json
{
  "sub": "user_abc",
  "email": "user@example.com",
  "domain": "app.example.com",
  "client_id": "hash_xyz",
  "role": "user",
  "iss": "unlike-other-authenticator",
  "iat": 1706742000,
  "exp": 1706745600
}
```

**Extended JWT claims (when org features enabled and user has an org):**

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
| `org.org_id` | string | The user's organisation ID on this domain |
| `org.org_role` | string | The user's role in the org (from `org_roles` config) |
| `org.teams` | string[] | IDs of teams the user belongs to (capped at `max_team_memberships_per_user`) |
| `org.team_roles` | object | Map of team_id to team role (`lead` or `member`) |
| `org.groups` | string[] | IDs of groups the user belongs to (only when `groups_enabled`) |
| `org.group_admin` | string[] | IDs of groups where the user has `is_admin = true` (only when `groups_enabled`) |

**If the user has no organisation on this domain**, the `org` claim is **omitted entirely** (not null, not empty — absent). This keeps the JWT lean for domains that don't use org features, and backwards-compatible for consuming products.

### JWT Size Awareness

JWT size grows linearly with team/group membership counts. The `max_team_memberships_per_user` config cap (default: 50) limits this growth. With 50 teams and 20 groups, the `org` claim adds approximately 4-5KB to the JWT. Consuming products with many teams per user may need to increase their reverse proxy/load balancer header buffer sizes (e.g., nginx default is 8KB).

### Stale JWT Claims

JWT `org` claims are populated at token issuance time and are not updated mid-session. If a user's org membership, team membership, or role changes, the updated claims will only appear after the user re-authenticates (consistent with existing token behavior per Section 22.10). Consuming products that need real-time org context should query the `/org/me` endpoint in addition to relying on JWT claims.

### Implementation

Modify `signAccessToken()` in `token.service.ts` to accept an optional `org` parameter in the existing flat params object:

```typescript
org?: {
  org_id: string;
  org_role: string;
  teams: string[];
  team_roles: Record<string, string>;
  groups: string[];
  group_admin: string[];
}
```

Include it in the JWT payload when present.

Modify `AccessTokenClaimsSchema` in `access-token.service.ts` to parse the optional `org` claim using Zod. The `AccessTokenClaims` type must include the optional org structure. Also update the hand-mapped return object in `verifyAccessToken()` to include the optional `org` claim.

Modify `exchangeAuthorizationCodeForAccessToken()` to query org/team/group memberships when config has `org_features.enabled`.

---

## Authentication & Middleware Chain for `/org/` Endpoints

The `/org/` endpoints use a **dual-auth pattern**: the product backend authenticates with a domain hash token, and the end user is identified via their access token. This section clarifies exactly how authentication works.

### Domain Context

All `/org/` endpoints require a `?domain=<domain>` query parameter (consistent with the existing `/domain/*` pattern). The domain hash bearer token in the `Authorization` header is verified against this domain parameter using `requireDomainHashAuthForDomainQuery`.

### Config Delivery

The `/org/` endpoints need the domain's config to check `org_features.enabled`, `groups_enabled`, limits, etc. They require a `?config_url=<url>` query parameter. The `config-verifier.ts` middleware fetches and verifies this config, attaching it to `request.config`. This is consistent with the "config verified on every request" philosophy from the existing brief.

### User Identity

For endpoints that need user context (all mutation endpoints + `/org/me`), the user's access token is passed in the `X-UOA-Access-Token` header (this header is already redacted in the Fastify logger config in `app.ts`). The `Authorization` header carries the domain hash token, so a separate header is needed for the user token.

### Full Middleware Chain

For a typical `/org/` endpoint:

```
Request
  → config-verifier.ts       (fetch & verify config from config_url, attach to request)
  → requireDomainHashAuthForDomainQuery  (verify Authorization bearer = hash(domain + secret))
  → org-features.ts          (check config.org_features.enabled, return 404 if disabled)
  → org-role-guard.ts        (extract X-UOA-Access-Token, verify, check org role)
  → Route handler
```

For org creation specifically: `org-role-guard.ts` must **not** require an org role (the user has no org yet). It only verifies the access token is valid and the user's domain matches the request domain. A variant or configuration option of the middleware handles this case.

### Cross-Domain Validation

The `org-role-guard.ts` middleware must verify that the `domain` claim in the user's access token matches the `?domain=` query parameter. This prevents a user from using an access token issued for domain A to access org data on domain B.

Additionally, the service layer must verify that any org referenced in the URL path (`:orgId`) actually belongs to the `?domain=` domain. This prevents IDOR attacks where a valid token and domain hash for domain A are used to access an org belonging to domain B.

---

## API Endpoints (User-Facing)

All user-facing endpoints live under `/org/` and require:
1. `?domain=<domain>` query parameter
2. `?config_url=<config_url>` query parameter
3. Domain hash bearer token in `Authorization` header
4. User access token in `X-UOA-Access-Token` header (for endpoints needing user context)

**All error responses must use `AppError` from `utils/errors.ts`. The global error handler returns only `{ error: "Request failed" }` to clients. No endpoint may return status-specific messages that leak information (e.g., "Forbidden" or "Insufficient role"). Internal error codes are for server-side logging only.**

### Organisation Management

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| POST | `/org/organisations` | Create an organisation. Creator becomes owner. Default team auto-created. | Any authenticated user on the domain (must not already belong to an org on this domain) |
| GET | `/org/organisations/:orgId` | Get organisation details | Any org member |
| PUT | `/org/organisations/:orgId` | Update org name/slug | Owner, Admin |
| DELETE | `/org/organisations/:orgId` | Delete org and all nested data | Owner only |
| GET | `/org/organisations/:orgId/members` | List org members with roles (paginated) | Any org member |
| POST | `/org/organisations/:orgId/members` | Add existing user to org (by userId, with role) | Owner, Admin |
| PUT | `/org/organisations/:orgId/members/:userId` | Change a member's org role | Owner only |
| DELETE | `/org/organisations/:orgId/members/:userId` | Remove member from org (cascades team/group memberships) | Owner, Admin (cannot remove last owner) |
| POST | `/org/organisations/:orgId/transfer-ownership` | Transfer ownership to another org member | Owner only |

#### Member Addition: No Email-Based Lookup

To prevent email enumeration (consistent with brief Section 11), the member addition endpoint accepts a **userId**, not an email. The consuming product is responsible for knowing its users' IDs. If the userId does not exist or does not belong to the domain, the endpoint returns a generic error (same `{ error: "Request failed" }` as all other errors). The response must not reveal whether the user exists.

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

#### User Deletion and Sole Ownership

If a user is the sole owner of an org (`Organisation.ownerId` points to them), the `onDelete: Restrict` on the Organisation model prevents the user from being deleted. The consuming product must transfer org ownership before deleting the user account.

### Team Management

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| GET | `/org/organisations/:orgId/teams` | List all teams in the org (paginated) | Any org member |
| POST | `/org/organisations/:orgId/teams` | Create a team | Owner, Admin |
| GET | `/org/organisations/:orgId/teams/:teamId` | Get team details + members | Any org member |
| PUT | `/org/organisations/:orgId/teams/:teamId` | Update team name/description | Owner, Admin |
| DELETE | `/org/organisations/:orgId/teams/:teamId` | Delete team (cannot delete default team) | Owner, Admin |
| POST | `/org/organisations/:orgId/teams/:teamId/members` | Add user to team (must be org member) | Owner, Admin |
| PUT | `/org/organisations/:orgId/teams/:teamId/members/:userId` | Change team role (lead/member) | Owner, Admin |
| DELETE | `/org/organisations/:orgId/teams/:teamId/members/:userId` | Remove user from team (cannot remove from last team) | Owner, Admin |

#### Team Constraints

- Cannot delete a team where `isDefault` is `true`.
- Cannot remove a user from their last team (they must be removed from the org instead, which cascades).
- `PUT` on team **cannot change `isDefault` or `groupId`**. Group assignment is a system-admin-only operation via the Internal API.

### Group Management (Read-Only for Users)

These endpoints return `404` if `org_features.groups_enabled` is `false` in the domain's config.

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| GET | `/org/organisations/:orgId/groups` | List all groups in the org (paginated) | Any org member |
| GET | `/org/organisations/:orgId/groups/:groupId` | Get group details + teams + members | Any org member |

**All group write operations (create, update, delete, member management, team-to-group assignment) are available only through the Internal API.** See below.

### Domain Admin: List Organisations

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| GET | `/org/organisations` | List all organisations on the domain (paginated) | Domain hash auth only (no user token needed) |

This is a domain-level admin endpoint for product backends. It requires domain hash auth but does not require a user access token.

### User's Own Org Context

| Method | Endpoint | Description | Who can call |
|--------|----------|-------------|-------------|
| GET | `/org/me` | Get the current user's org, teams, groups for the current domain | Any authenticated user |

This is a convenience endpoint for client apps to fetch the user's full org context after login. Returns the same structure as the JWT `org` claim but always reflects the current database state (not cached in a token).

### Pagination

All list endpoints support cursor-based pagination:

- Query parameters: `?limit=50&cursor=<last_id>`
- Response format: `{ data: [...], next_cursor: "..." | null }`
- Default limit: 50
- Maximum limit: 200

### Rate Limiting

Extend the existing `rate-limiter.ts` middleware for `/org/` routes:

- Org creation: 5 per user per domain per hour
- Member addition: 100 per org per hour
- Team creation: 50 per org per hour
- Read endpoints: standard API rate limits

---

## Internal API for System-Admin Operations

Group management and team-to-group assignment are **system-admin-only operations**. System admins are backend services operated by the product owner — they are not human users with org roles. These operations use **signed request authentication** without a user access token.

### Authentication

Internal API endpoints require:
1. `?domain=<domain>` query parameter
2. Domain hash bearer token in `Authorization` header (same `requireDomainHashAuthForDomainQuery` pattern)
3. `?config_url=<config_url>` query parameter (for feature gate checks)
4. **No user access token needed** — these are machine-to-machine calls

The domain hash token (hash of domain + shared secret) already represents full system trust. Any backend possessing the shared secret is implicitly a system admin. This is consistent with the existing trust model: the shared secret is the single root of trust.

### Route Prefix

All internal endpoints live under `/internal/org/`:

```
/src/routes/internal/org/
  groups.ts                 — group CRUD
  group-members.ts          — group member management
  team-group-assignment.ts  — assign/unassign teams to groups
```

### Internal Middleware Chain

```
Request
  → config-verifier.ts                     (fetch & verify config)
  → requireDomainHashAuthForDomainQuery    (verify domain hash token)
  → org-features.ts                        (check org_features.enabled)
  → groups-enabled.ts                      (check org_features.groups_enabled, return 404 if disabled)
  → Route handler
```

No `org-role-guard.ts` — there is no user in the request.

### Internal API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/internal/org/organisations/:orgId/groups` | Create a group |
| PUT | `/internal/org/organisations/:orgId/groups/:groupId` | Update group name/description |
| DELETE | `/internal/org/organisations/:orgId/groups/:groupId` | Delete group (teams become ungrouped) |
| POST | `/internal/org/organisations/:orgId/groups/:groupId/members` | Add group member (with is_admin flag) |
| DELETE | `/internal/org/organisations/:orgId/groups/:groupId/members/:userId` | Remove group member |
| PUT | `/internal/org/organisations/:orgId/groups/:groupId/members/:userId` | Toggle is_admin flag |
| PUT | `/internal/org/organisations/:orgId/teams/:teamId/group` | Assign or unassign a team to/from a group |

#### Team-Group Assignment

`PUT /internal/org/organisations/:orgId/teams/:teamId/group` accepts `{ groupId: string | null }`. Setting `groupId` to `null` ungroups the team. The service must verify:
1. The team belongs to the specified org.
2. The group (if provided) belongs to the same org.
3. `groups_enabled` is `true` in the config.

### Security Note

The internal API must **never** be exposed directly to end users. In production deployments, these endpoints should be network-restricted (e.g., internal VPC only, API gateway rules) in addition to requiring the domain hash token. The authenticator itself does not enforce network-level restrictions — that is the deployer's responsibility.

---

## Service Layer

Create new service files following the existing pattern (thin routes, fat services):

| File | Responsibility |
|---|---|
| `organisation.service.ts` | Create/update/delete orgs, manage members, enforce owner constraints, slug generation, ownership transfer, member removal cascade |
| `team.service.ts` | Create/update/delete teams, manage team members, enforce limits, default team protection |
| `group.service.ts` | Create/update/delete groups, manage group members, team-group assignment, enforce limits, feature gate check |
| `org-context.service.ts` | Query a user's full org context (org + teams + groups) for JWT enrichment and `/org/me` |

Each service must:
- Accept a Prisma client instance (for testability, same pattern as `token.service.ts`).
- Validate limits from config (`max_teams_per_org`, `max_members_per_org`, `max_team_memberships_per_user`, etc.).
- Use transactions where atomicity matters (e.g., creating an org + adding the creator as owner + creating default team).
- Never expose internal error details to callers (use `AppError` from `utils/errors.ts`). The global error handler ensures only `{ error: "Request failed" }` is returned to clients.
- Validate the IDOR ownership chain: every operation must verify that the referenced org belongs to the request domain, that the referenced team/group belongs to the referenced org, etc.

### One Org Per User Per Domain Enforcement

The `@@unique([orgId, userId])` constraint on `OrgMember` only prevents duplicate membership within one org. To enforce "one org per user per domain," the service must:
1. Query: "Does this user already belong to any org on this domain?" before adding them to an org.
2. This check runs inside the transaction that creates the `OrgMember` record.
3. With `user_scope: "per_domain"`, this is naturally enforced because each user record is already domain-scoped. With `user_scope: "global"`, the same user ID can appear across domains, so the check must be explicit.

---

## Route Layer

Create new route files:

```
/src/routes/org/
  organisations.ts          — POST/GET/PUT/DELETE org endpoints + list orgs for domain
  org-members.ts            — org member management endpoints + ownership transfer
  teams.ts                  — team CRUD endpoints
  team-members.ts           — team member management endpoints
  groups.ts                 — GET group endpoints (read-only for users)
  me.ts                     — GET /org/me

/src/routes/internal/org/
  groups.ts                 — group CRUD (internal)
  group-members.ts          — group member management (internal)
  team-group-assignment.ts  — team-to-group assignment (internal)
```

User-facing routes (`/src/routes/org/`) must:
1. Be gated behind `org-features.ts` middleware that checks `config.org_features.enabled` and returns `404` if disabled.
2. Group read routes must additionally check `config.org_features.groups_enabled`.
3. Use `requireDomainHashAuthForDomainQuery` for domain-level authorization.
4. Use `org-role-guard.ts` for user identity and org role verification.

Internal routes (`/src/routes/internal/org/`) must:
1. Be gated behind `org-features.ts` and `groups-enabled.ts` middleware.
2. Use `requireDomainHashAuthForDomainQuery` for domain-level authorization.
3. NOT use `org-role-guard.ts` (no user context).

---

## Middleware

### New: `org-features.ts`

Checks that `org_features.enabled` is `true` in the current domain's config (from `request.config`). Returns `404 Not Found` if not. This keeps the org endpoints invisible to domains that don't use them. Uses the existing generic error response pattern.

### New: `groups-enabled.ts`

Checks that `org_features.groups_enabled` is `true` in the current domain's config. Returns `404 Not Found` if not. Used for group endpoints (both user-facing reads and internal writes).

### New: `org-role-guard.ts`

A factory middleware. Given a list of allowed org roles (e.g., `['owner', 'admin']`) or `null` (for endpoints that just need a valid user, like org creation), it:
1. Extracts the access token from the `X-UOA-Access-Token` header.
2. Verifies the access token using the same verification as `verifyAccessToken()`.
3. Checks the `domain` claim in the token matches the `?domain=` query parameter.
4. If role checking is enabled: looks up the user's org membership for the org in the URL and checks their role.
5. Returns a generic error (via `AppError`) if any check fails. The status code is always handled by the global error handler which returns `{ error: "Request failed" }`.

---

## Operational Lifecycle

### Enabling `org_features` on an Existing Domain

When `org_features` is enabled on a domain that already has users, none of those users belong to an org. The authenticator does not perform any migration. The consuming product is responsible for:
1. Prompting users to create or join organisations via the API.
2. Handling the JWT gracefully when the `org` claim is absent (meaning the user has not yet joined an org).
3. Optionally using the Internal API to pre-create orgs and assign users.

### Disabling `org_features` on a Domain with Existing Orgs

Disabling `org_features` (setting `enabled: false` in config) hides all org endpoints (they return `404`) and omits `org` claims from JWTs. **Existing data is NOT deleted.** Re-enabling the feature restores access to existing orgs and their data. If permanent removal is needed, the consuming product must delete orgs via the API before disabling the feature.

### `org_roles` Config Changes

If `org_roles` changes and existing members have roles no longer in the list, those members retain their stored role. The consuming product must handle migration (e.g., bulk-update roles via the API). The authenticator validates roles only on write — not on read. The JWT will contain whatever role is stored, even if it is no longer in the current config's `org_roles`.

---

## Documentation Updates

After implementing, update these docs:

1. **`Docs/brief.md`** — Add a new section (Section 24 or similar): "Organisations, Teams & Groups". Document the concepts, config claim, JWT changes, API endpoints (user-facing and internal), and constraints. Follow the existing brief's style and level of detail.

2. **`Docs/techstack.md`** — Update the database section to list the new tables (`organisations`, `org_members`, `teams`, `team_members`, `groups`, `group_members`). Update the API section to mention org management endpoints and the internal API.

3. **`Docs/architecture-api.md`** — Add the new route files (including `/src/routes/internal/org/`), service files, and middleware to the directory structure. Add the `/org/` and `/internal/org/` route groups to the layered architecture description.

4. **Do NOT modify `CLAUDE.md` or `AGENTS.md`** — those are project rules, not feature docs.

---

## Constraints & Non-Negotiables

1. **Completely generic.** No product-specific concepts. No "venues", "forecasts", "P&L", "pubs", or anything domain-specific. The authenticator knows about users, orgs, teams, and groups — nothing about what those teams *do*.

2. **Backwards compatible.** Existing auth flows must work identically when `org_features` is not in the config. No breaking changes to existing JWT claims, endpoints, or behaviour.

3. **No admin dashboard.** This is an API-only addition. No UI changes to the Auth window. Products build their own team/group management UI.

4. **No refresh tokens.** Unchanged from the brief. When team/group membership changes, the user must re-authenticate to get updated JWT claims.

5. **Existing security rules apply.** Generic error messages only — all responses use `{ error: "Request failed" }` via the global error handler. No enumeration. No information leakage from status codes or error messages. Shared secret never exposed.

6. **File size limit: 500 lines.** No exceptions. Split services if they grow.

7. **Follow existing code patterns.** Look at `token.service.ts`, `domain-role.service.ts`, `domain-hash-auth.ts`, `access-token.service.ts`, and the route files for style, error handling, dependency injection, and testing patterns.

8. **Prisma only.** No raw SQL. Use transactions for multi-step mutations.

9. **Slug generation.** See the "Slug Rules" section above. Random suffixes on collision, not incrementing numbers.

10. **Deletion cascades.** Deleting an org deletes all its teams, groups, and memberships. Deleting a team deletes its memberships (but cannot delete the default team). Deleting a group sets `groupId = null` on its teams and deletes group memberships. Removing a user from an org cascades to their team and group memberships within that org.

11. **The `org_roles` list in config is the source of truth** for what roles are valid in that domain on write. `"owner"` is reserved and must always be present. Roles are validated on write, not on read. The authenticator stores the role string. It does not interpret what custom roles *mean* — that's up to the consuming product.

12. **One org per user per domain.** A user can only belong to one organisation on a given domain. Attempting to join a second org should fail. (With global user_scope, the same human can be in different orgs on different domains.) This is enforced at the application layer since the DB constraint alone is insufficient.

13. **Every user must be in at least one team.** When joining an org, the user is added to the default team. They cannot be removed from their last team — remove them from the org instead.

14. **Group write operations are internal-only.** Groups are managed by system admins via the Internal API (`/internal/org/`), not by org admins through user-facing endpoints.

15. **Member addition by userId, not email.** To prevent email enumeration, the member addition endpoint accepts user IDs. The consuming product looks up user IDs through its own means (e.g., the existing `/domain/users` endpoint).

16. **IDOR prevention.** Every operation must verify the full ownership chain: domain → org → team/group → member. A valid domain hash token for domain A must not grant access to resources on domain B.

---

## Task Breakdown

### Phase A: Schema & Config

| # | Task |
|---|------|
| A.1 | Add `org_features` validation to config JWT schema in `config.service.ts` (Zod schema, optional, with defaults, `"owner"` required in `org_roles`) |
| A.2 | Add `Organisation` (with `ownerId`, `slug`), `OrgMember` (with `updatedAt`), `Team` (with `isDefault`, field lengths), `TeamMember` (with `updatedAt`), `Group`, `GroupMember` (with `updatedAt`) models to Prisma schema |
| A.3 | Add relations to existing `User` model (including `ownedOrgs` for `OrgOwner` relation) |
| A.4 | Generate and apply Prisma migration |

### Phase B: Services

| # | Task |
|---|------|
| B.1 | Create `organisation.service.ts` — CRUD, member management (by userId), owner protection, slug generation (random suffix on collision), ownership transfer, default team auto-creation, member removal cascade, one-org-per-user-per-domain enforcement |
| B.2 | Create `team.service.ts` — CRUD, member management, limit enforcement, default team protection, last-team-removal prevention, `max_team_memberships_per_user` enforcement |
| B.3 | Create `group.service.ts` — CRUD, member management, team-group assignment, limit enforcement, feature gate check |
| B.4 | Create `org-context.service.ts` — query user's full org context (org + teams + groups) for JWT enrichment and `/org/me` |
| B.5 | Modify `token.service.ts` — extend `signAccessToken()` params with optional `org` object, include org claims in JWT payload |
| B.6 | Modify `access-token.service.ts` — extend `AccessTokenClaimsSchema` with optional `org` Zod schema, extend `AccessTokenClaims` type, update `verifyAccessToken()` hand-mapped return object |
| B.7 | Modify `exchangeAuthorizationCodeForAccessToken()` to query org context via `org-context.service.ts` when config has `org_features.enabled` |

### Phase C: Middleware & Routes

| # | Task |
|---|------|
| C.1 | Create `org-features.ts` middleware (checks `config.org_features.enabled`, returns 404 via AppError) |
| C.2 | Create `groups-enabled.ts` middleware (checks `config.org_features.groups_enabled`, returns 404 via AppError) |
| C.3 | Create `org-role-guard.ts` factory middleware (extract `X-UOA-Access-Token`, verify, check domain match, check org role) |
| C.4 | Create user-facing organisation routes (`/org/organisations` CRUD + list for domain + members + ownership transfer) with pagination |
| C.5 | Create user-facing team routes (`/org/organisations/:orgId/teams` CRUD + members) with pagination |
| C.6 | Create user-facing group read routes (`/org/organisations/:orgId/groups` GET only) with pagination |
| C.7 | Create `/org/me` route |
| C.8 | Create internal group routes (`/internal/org/organisations/:orgId/groups` CRUD) |
| C.9 | Create internal group member routes (`/internal/org/organisations/:orgId/groups/:groupId/members`) |
| C.10 | Create internal team-group assignment route (`/internal/org/organisations/:orgId/teams/:teamId/group`) |
| C.11 | Register all new routes (user-facing and internal) in the app setup |

### Phase D: Documentation

| # | Task |
|---|------|
| D.1 | Add Section 24 to `Docs/brief.md` — Organisations, Teams, Groups, Internal API, all constraints |
| D.2 | Update `Docs/techstack.md` — new tables, org management endpoints, internal API |
| D.3 | Update `Docs/architecture-api.md` — new route files (including `/internal/org/`), services, middleware |

### Phase E: Testing

| # | Task |
|---|------|
| E.1 | Unit tests for `organisation.service.ts` (CRUD, slug generation, ownership transfer, member cascade, one-org-per-domain) |
| E.2 | Unit tests for `team.service.ts` (CRUD, default team protection, last-team prevention, membership limits) |
| E.3 | Unit tests for `group.service.ts` (CRUD, team-group assignment, feature gate, membership limits) |
| E.4 | Unit tests for `org-context.service.ts` |
| E.5 | Unit tests for modified token services (org claims in JWT, verify round-trip) |
| E.6 | Integration tests for user-facing `/org/` endpoints (org CRUD, team CRUD, group reads, pagination, rate limiting) |
| E.7 | Integration tests for internal `/internal/org/` endpoints (group CRUD, group members, team-group assignment) |
| E.8 | Integration test: full flow (create org → verify default team → add team → add members → login → verify JWT contains org claims) |
| E.9 | Integration test: org features disabled → all `/org/` and `/internal/org/` endpoints return 404, JWT has no org claims |
| E.10 | Integration test: IDOR prevention — verify cross-domain access is rejected, cross-org access is rejected |
| E.11 | Integration test: member addition returns generic error for non-existent userId (no enumeration) |
| E.12 | Integration test: sole owner deletion blocked, ownership transfer works |
