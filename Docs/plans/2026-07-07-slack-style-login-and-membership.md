# Slack-Style Login & Membership Model — Design

> **Status:** proposed design, not yet implemented
> **Date:** 2026-07-07
> **Scope:** `/API` (schema, services, routes), `/Auth` (login flow UI), token claims
> **Inputs:** public-behaviour model of Slack (identity vs workspace membership), current UOA implementation

This document designs what needs to change in UOA to replicate how Slack handles logins and membership: a global person identity, workspace memberships with lifecycle states, email-first sign-in with workspace selection, richer invitations, and deactivation-vs-removal semantics.

It is **additive**. Nothing in `Docs/brief.md` is removed; where the Slack model conflicts with an existing UOA invariant, the conflict is flagged in §9 with a recommended resolution rather than silently decided.

---

## 1. Concept mapping — Slack → UOA

Slack's model:

```
Enterprise Org
  └── Workspaces
        └── Workspace memberships (status, role, guest type)
              └── Channel memberships
Person = global identity + N workspace memberships + N auth methods + N sessions
```

UOA already has most of the nouns. The mapping this design commits to:

| Slack concept | UOA concept | Notes |
|---|---|---|
| Slack (the service) | `ClientDomain` | The tenant boundary. Each consuming product ≈ one "Slack". |
| Enterprise Grid org | `Organisation` | Already exists, auto-created in single-team mode (roles-and-acl.md §Auto-organisation rule). |
| **Workspace / team** | **`Team`** | The unit users join, get invited to, and select at login. See §9.1 for why *not* `Organisation`. |
| Workspace membership | `TeamMember` (+ `OrgMember`) | Exists, but has **no lifecycle status** today — the biggest gap. |
| Channel / channel membership | *Out of scope* | UOA stores no channels; conversation-level ACL is the consuming app's concern (consistent with "consumer-defined roles" in roles-and-acl.md). |
| Separate account per workspace | `user_scope: "per_domain"` | Already exists (brief §22.12). |
| Enterprise Grid shared identity | `user_scope: "global"` | Already exists and is the default. |
| Auth methods per person | **Missing** — merge-by-email only | New `AuthIdentity` model, §4.2. |
| Sessions | `RefreshToken` families + short-lived access JWT | Exists; needs optional workspace scoping, §4.4. |
| Sign-in code (password-free) | **Missing** — magic links only | New `LOGIN_CODE` flow, §4.3. |
| Workspace chooser after email verify | **Missing** | New selection step in the Auth window, §4.3. |
| Invited member (pre-activation state) | `TeamInvite` (separate table, not a membership state) | Kept as source of truth for pending state; surfaced as `invited` membership, §4.1. |
| Deactivation vs removal | **Missing** — memberships are hard-deleted | Soft lifecycle states, §4.5. |
| Join policies (invite-only / domain / request / open / hidden) | Partially present, scattered | Unified `joinPolicy` on `Team`, §4.6. |
| Invite approval, invite links, guests | **Missing** | §4.7, §4.8. |
| SAML SSO / SCIM | Specified, deferred | No change — `roles-and-acl.md §SCIM` remains the spec. Microsoft SSO covers the near-term enterprise login need. |
| Role on membership, never on user | Already UOA's model | `DomainRole`, `OrgMember.role`, `TeamMember.teamRole`. Needs consistency fixes, §4.9. |

The core Slack lesson — *never put permissions on the user; put them on memberships scoped to org/workspace* — is already UOA's architecture. What UOA is missing is the **lifecycle** (invited → active → deactivated → removed), the **email-first login with workspace selection**, and a **first-class auth-identity record**.

---

## 2. Current state (what exists today)

Grounding for the gap analysis; file references are to `/API/src`.

* **Login** is config-JWT-driven per client domain. `POST /auth/login` (email+password) or social callback → 2FA policy resolution → `finalizeAuthenticatedUser` (`services/access-request-flow.service.ts`) → **authorization code** (`services/token.service.ts`), which the client backend exchanges at `POST /auth/token` for an HS256 access JWT + rotating opaque refresh token.
* **Email-first already half-exists**: `POST /auth/register` takes `{ email }` only, always answers generically, and sends a magic **link** (`LOGIN_LINK` for existing users, `VERIFY_EMAIL[_SET_PASSWORD]` for new ones). `registration_mode: "passwordless"` supports password-free accounts. There is **no numeric code** option and **no workspace chooser** — the link lands the user straight into the single configured flow.
* **Memberships**: `OrgMember` (unique `[orgId, userId]`, string role) and `TeamMember` (unique `[teamId, userId]`, string role). No `status` column on either; removal is a hard `DELETE` cascading team/group rows (brief §24.3).
* **Invites**: `TeamInvite` with derived status (`pending | accepted | declined | replaced`), email-token acceptance atomically creating user + memberships (`services/auth-verify-email.service.ts` → `team-invite.service.acceptance.ts`). No invite expiry (only the emailed token expires), no approval step, no invite links, no guest concept. Invite creation is **backend-only** (domain-hash auth on `routes/org/team-invitations.ts`) — members cannot invite.
* **Self-join paths**: `registration_domain_mapping` config + org/team `allowedEmailDomains[]`/`allowedEmails[]` (approved-domain join), `AccessRequest` (request-to-join with admin review), `org-placement.service.ts` / `user-team-requirement.service.ts` (auto-create/self-heal). These exist but are not unified under a per-team join policy.
* **Sessions**: `RefreshToken` bound to `{ userId, domain, clientId, configUrl }` with family rotation + reuse detection; `User.tokenVersion` gives **global** (all-domains) revocation only. Org claims are re-resolved from DB on every refresh (brief §24.7), which is the hook that makes membership lifecycle enforcement cheap.
* **Identity**: account unification is merge-by-email; no record of *which* providers a user has linked (the `method` token claim in `api-changes-rebac.md §5` has nowhere to be persisted).

---

## 3. Gap summary

| # | Gap | Slack behaviour | Change |
|---|---|---|---|
| G1 | No membership lifecycle | invited / active / deactivated / removed, billing-relevant | `status` on `OrgMember` + `TeamMember`; invites surfaced as `invited` |
| G2 | No auth-identity record | person has N auth methods | New `AuthIdentity` model |
| G3 | No sign-in code | email → 6-digit code → in | New `LOGIN_CODE` token type + endpoints (opt-in) |
| G4 | No workspace selection at login | verified email → list workspaces + invites → pick one → policy → session | New selection step in Auth window; code/session optionally team-scoped |
| G5 | Removal is destructive | deactivate keeps content; workspace removal keeps org identity | Soft states + scoped session revocation |
| G6 | Join paths not unified | per-workspace policy incl. hidden/open | `joinPolicy` enum on `Team` |
| G7 | Invites: no expiry/approval/links/member-initiated | 30-day links, admin approval mode, members can invite | `TeamInvite` additions + `TeamInviteLink` + user-facing invite endpoint |
| G8 | No guests | single/multi-channel guests | Minimal `isGuest` semantics (no channels → reduced scope), deferred by default |
| G9 | Role vocabulary inconsistent | layered, well-defined roles | Adopt `TeamRole` enum from `api-changes-rebac.md §1`; enforce in guard |
| G10 | Membership changes not audited | audit log | Org-scoped audit log |

---

## 4. Design

### 4.1 Membership lifecycle states (G1)

Add a status enum shared by org and team memberships:

```prisma
enum MembershipStatus {
  ACTIVE
  DEACTIVATED  // admin-suspended; sign-in to this scope blocked; history retained
  REMOVED      // removed from the workspace/org; row retained as tombstone
}
```

* `OrgMember` and `TeamMember` each gain `status MembershipStatus @default(ACTIVE)` and `statusChangedAt DateTime?`.
* The existing `@@unique([orgId, userId])` / `@@unique([teamId, userId])` constraints are kept — a `REMOVED`/`DEACTIVATED` row is flipped back to `ACTIVE` on re-add instead of inserting a duplicate. Re-add endpoints become upserts on status.
* **`INVITED` is deliberately not a membership status.** Slack's "invited member" state stays represented by the pending `TeamInvite` row (it already carries email, role-to-assign, inviter, open tracking). Creating placeholder `User` + membership rows for un-accepted invitees would break UOA's invariants (no user without verified email, enumeration surface, RLS tenancy). Instead, read paths that list members gain an option to merge pending invites in as `{ status: "invited", email, invitedBy, ... }` entries — Slack's UX without Slack's placeholder accounts.
* All existing read paths (`getUserOrgContext`, `org-context.service.ts`; member lists; `firstLogin`; token claims) filter to `status: ACTIVE`. This is the single most important enforcement point: because org claims are re-resolved on every refresh, a deactivated membership disappears from tokens within one access-token TTL with no new revocation machinery.
* Write paths (`acceptTeamInviteWithinTransaction`, `org-placement`, `user-team-requirement`, auto-enrolment upserts) must not resurrect `DEACTIVATED` rows (`update: {}` upserts already have the right shape; add an explicit status guard so auto-enrolment does not silently re-activate a suspended member).

### 4.2 Auth identities (G2)

New model, per the Slack `auth_identities` shape:

```prisma
model AuthIdentity {
  id              String    @id @default(cuid())
  userId          String    @map("user_id")
  provider        String    // "email" | "google" | "github" | "microsoft" | "apple" | "facebook" | "linkedin"
  providerSubject String    @map("provider_subject") // provider user id; for "email": the email itself
  email           String    @db.Citext
  providerTenant  String?   @map("provider_tenant")  // e.g. Microsoft Entra `tid` (roles-and-acl.md stores-but-not-enforces)
  verifiedAt      DateTime? @map("verified_at")
  lastLoginAt     DateTime? @map("last_login_at")
  createdAt       DateTime  @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerSubject])
  @@index([userId])
  @@index([email])
  @@map("auth_identities")
}
```

* Written on every successful login (upsert): social callbacks record the provider subject; email-link/code logins record an `email` identity. Existing behaviour (merge-by-verified-email, avatar overwrite per brief §22.7) is unchanged — this table *records* the merge instead of losing it.
* Backfill: create an `email` identity per existing user (`verifiedAt = User.createdAt`); password hash stays on `User` (it is a credential, not an identity).
* This gives the `method` claim (`api-changes-rebac.md §5`) a persistence home, gives SCIM's `scimExternalId` a natural future sibling, and lets per-provider auto-enrolment (`VerificationMethod` matching) audit *which* identity satisfied the rule.

### 4.3 Email-first login: sign-in codes + workspace selection (G3, G4)

Slack's flow, translated into UOA's popup/config architecture. Everything happens **inside the Auth window for one client domain** — the workspace list is teams on that domain, never cross-domain (tenancy preserved).

**New config claims** (extend `ClientConfigSchema` in `config.service.ts`, same optional-with-defaults Zod pattern as `org_features`):

```jsonc
"login_flow": {
  "email_code_enabled": false,      // offer "email me a code" (else links only, current behaviour)
  "workspace_selection": "off"      // "off" | "auto" — "auto": show chooser when the user has 2+ active teams or any pending invite
}
```

**Endpoints** (all under the existing config-verified `/auth/*` family; every addition mirrored in `API/src/routes/root/index.ts` and `llm.ts` per CLAUDE.md):

1. `POST /auth/start` — body `{ email }`. Behaviour of today's `POST /auth/register` (it already is Slack's step 1), plus: when `email_code_enabled`, the email contains a 6-digit code alongside/instead of the link. Response is always the generic "We sent instructions to your email" — **no enumeration**, workspace names revealed only after verification.
2. `POST /auth/verify-code` — body `{ email, code }`. Verifies a new `LOGIN_CODE` verification token (see below). On success returns a short-lived **login-session bridge token** (same pattern as the existing `twofa_token` bridge JWT in `twofactor-policy.service.ts`) plus, when `workspace_selection` is on:
   ```json
   {
     "login_token": "…",
     "teams": [ { "teamId": "…", "orgId": "…", "name": "…", "role": "member" } ],
     "pending_invites": [ { "inviteId": "…", "teamName": "…", "invitedBy": "…" } ],
     "can_create_org": false
   }
   ```
   Only `status: ACTIVE` memberships are listed; `DEACTIVATED` teams are omitted (generic — the UI never says "you were suspended"). Shape intentionally mirrors the existing `firstLogin` block (`first-login.service.ts`) so `/Auth` reuses one component.
3. `POST /auth/select-team` — body `{ login_token, teamId }` (or `{ login_token, inviteId }` to accept a pending invite, or `{ login_token }` alone when the chooser is skipped/empty). Checks, in order — Slack's step 5:
   * bridge token valid, unexpired, unused;
   * membership exists and `status == ACTIVE` (or invite valid → accept via existing `acceptTeamInviteWithinTransaction`);
   * team/org auth policy: resolve 2FA via existing `resolveTwoFaPolicy` for the *selected* org — may return a `twofa_token` challenge instead of completing;
   * `assertEmailDomainAllowedForLogin` (existing gate) still applies.
   Then `finalizeAuthenticatedUser` issues the authorization code, now carrying the selected team (§4.4).
4. Password login (`POST /auth/login`) and social callbacks route into the same selection step when `workspace_selection` is on: instead of finalizing immediately, they return the same `{ login_token, teams, pending_invites }` payload. With `workspace_selection: "off"` (default) nothing changes for existing integrators.

**`LOGIN_CODE` token type**: add to `VerificationTokenType`. Same table, hashed like link tokens, but: 6 digits, ~10-minute TTL, single active code per `(userKey, domain)` (issuing supersedes prior), and a new `attemptCount Int @default(0)` column on `VerificationToken` — max 5 verify attempts, then the code is dead and the user restarts. `POST /auth/verify-code` is IP- and email-key rate-limited via the existing `rate-limiter.ts` patterns, and failures return the standard generic error (brief §22.11). Magic-link flows are unaffected; codes are strictly additive.

**Magic links join the same flow**: the email-link landing (`/auth/email-*` routes) currently finalizes directly; when `workspace_selection` is on, a consumed link also lands on the chooser (the link *is* the verification). This keeps one canonical post-verification path: `verified identity → chooser → select-team → policy → code`.

### 4.4 Workspace-scoped sessions (G4)

Slack scopes the session to the chosen workspace. UOA's session objects gain optional team scope:

* `AuthorizationCode` + `RefreshToken`: add nullable `orgId` / `teamId` columns. Populated by `select-team`; null for flows with the chooser off (fully backward-compatible).
* Access-token claims: when a team was selected, add an `active` claim next to the existing org claims — `"active": { "orgId": "…", "teamId": "…" }`. The full `orgs[]`/`org` claim continues to describe *all* active memberships (shape per `api-changes-rebac.md §5`, which remains canonical); `active` only says which workspace this session was opened for. Consuming apps that ignore it see no change.
* Refresh re-resolution (existing behaviour) now also validates the scoped membership: if the `active` team membership is no longer `ACTIVE`, the refresh either succeeds with `active` dropped (membership lost, identity fine) — recommended — or fails when the *user-level* state demands it. Deactivation enforcement therefore needs no token-version bump.
* **Workspace switching** ("add/switch workspaces from the sidebar"): no new grant. The consuming app re-runs the OAuth flow; because the user's email is already verified in the Auth window session context, the chooser is one click. A dedicated silent "switch" grant on an existing refresh token is explicitly deferred — it would give client backends cross-team tokens without user interaction, which needs its own security review.

### 4.5 Deactivation vs removal (G5)

Slack's rule: deactivation removes access, never content. Mapped to UOA:

| Operation | Effect |
|---|---|
| **Deactivate org member** — `POST /org/organisations/:orgId/members/:userId/deactivate` | `OrgMember.status = DEACTIVATED`; all that org's `TeamMember` rows → `DEACTIVATED`; revoke refresh-token families for `(userId, domain)` where the org matches (scoped revocation — new query on `refresh_tokens`, which already carries `domain`, plus new `orgId`); memberships vanish from claims on next refresh; audit row. `LoginLog`, invites, audit history retained. |
| **Reactivate** — `POST .../members/:userId/reactivate` | Status back to `ACTIVE` (org + team rows deactivated by the same operation). No sessions restored — user signs in again. |
| **Remove from team** — existing `DELETE .../teams/:teamId/members/:userId` | Becomes `TeamMember.status = REMOVED` (tombstone) instead of row delete. Org identity untouched — Slack's "removed from workspace, still in the org". Existing "cannot leave your last team" rule now counts `ACTIVE` rows only. |
| **Remove from org** — existing `DELETE .../members/:userId` | `OrgMember` + that org's `TeamMember`/`GroupMember` rows → `REMOVED` (replaces today's hard-delete cascade from brief §24.3, which is preserved semantically: the user is gone from all rosters — just recoverable and auditable now). Scoped session revocation as above. |
| **User-level deactivation** | Out of scope here — that is the SCIM soft-deprovision spec (`roles-and-acl.md`), which this lifecycle model is a prerequisite for and is designed to slot into (`PATCH {active:false}` = deactivate all org memberships + bump `tokenVersion`). |

Hard deletion remains available only as an explicit admin operation (unchanged), not the default membership-removal path.

### 4.6 Team join policies (G6)

Unify the scattered join mechanisms under one per-team switch:

```prisma
enum TeamJoinPolicy {
  INVITE_ONLY      // default — current implicit behaviour
  APPROVED_DOMAIN  // allowedEmailDomains / OrgEmailDomainRule auto-join
  REQUEST_TO_JOIN  // AccessRequest flow
  OPEN_TO_ORG      // any ACTIVE org member may self-join
  HIDDEN           // never listed in discovery; invite-only
}
```

* `Team.joinPolicy TeamJoinPolicy @default(INVITE_ONLY)`.
* The policy **gates the existing mechanisms rather than replacing them**: auto-enrolment (`org-placement` / `OrgEmailDomainRule` matching) only fires for `APPROVED_DOMAIN` teams; `AccessRequest` creation is only accepted for `REQUEST_TO_JOIN` teams; a new `POST /org/organisations/:orgId/teams/:teamId/join` (self-join) exists only for `OPEN_TO_ORG`; `HIDDEN` teams are excluded from any org-member-visible team listing and from the login chooser unless the user is already a member.
* Migration backfill: teams with `allowedEmailDomains`/matching mapping rules → `APPROVED_DOMAIN`; teams referenced by access-request config → `REQUEST_TO_JOIN`; all others `INVITE_ONLY`. Invites keep working under every policy (Slack's invitation path is always available).

### 4.7 Invitation upgrades (G7)

`TeamInvite` additions:

```prisma
expiresAt      DateTime?             @map("expires_at")        // invite-level expiry (default 30 days), independent of email-token TTL
approvalStatus InviteApprovalStatus  @default(NOT_REQUIRED) @map("approval_status")
requestedByUserId String?            @map("requested_by_user_id") // member who proposed it, when approval was required

enum InviteApprovalStatus { NOT_REQUIRED PENDING APPROVED DENIED }
```

* **Expiry**: derived-status logic in `team-invite.service.base.ts` adds `expired`; expired invites can be re-sent (refreshing `expiresAt`), matching Slack's re-invite UX. `firstLogin.pending_invites` and the login chooser exclude expired/denied invites.
* **Member-initiated invites**: new user-facing endpoint `POST /org/organisations/:orgId/teams/:teamId/invitations` authenticated with the user access token (dual-auth pattern of brief §24.8), alongside the existing domain-hash backend endpoint. Permission: org/team `admin`/`owner` always; plain `ACTIVE` members only when the new org setting `member_invites: "allowed" | "admin_approval" | "disabled"` (org-level, admin-managed) permits. Slack's default — members may invite, owners can require approval — maps to `allowed` as the default.
* **Approval flow**: with `member_invites: "admin_approval"`, a member's invite is created with `approvalStatus: PENDING` and **no email is sent**; org admins list/approve/deny via `GET/POST /org/organisations/:orgId/invitations/pending-approval[…]/approve|deny`. Approval flips to `APPROVED` and sends the email through the existing send path. Deny is silent to the invitee (nothing was ever sent).
* **Invite links** (`TeamInviteLink`): shareable non-personal invite, Slack-style (30-day default expiry, capped uses):

```prisma
model TeamInviteLink {
  id              String    @id @default(cuid())
  orgId           String    @map("org_id")
  teamId          String    @map("team_id")
  tokenHash       String    @unique @map("token_hash")
  createdByUserId String?   @map("created_by_user_id")
  roleToAssign    String    @default("member") @map("role_to_assign")
  expiresAt       DateTime  @map("expires_at")   // default now + 30 days
  maxUses         Int       @default(400) @map("max_uses")
  useCount        Int       @default(0) @map("use_count")
  revokedAt       DateTime? @map("revoked_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  // relations: org, team (Cascade)
  @@index([teamId])
  @@map("team_invite_links")
}
```

  Landing at `/auth/team-invite-link/:token` requires the visitor to complete normal email verification (link or code) before membership is granted — the link authorizes *joining*, never *authentication*. `useCount` increments atomically on successful join; expiry/revocation/cap failures render the generic invalid-link page. Per Slack, invite links are refused (creation blocked) when the team's effective policy forbids self-serve entry (`HIDDEN`) — and later, when SSO-required orgs exist, links are disabled there too.

### 4.8 Guests (G8) — deferred, shape reserved

Slack's guest tiers are channel-based; UOA has no channels, so single- vs multi-channel guests cannot map faithfully. Rather than inventing semantics, reserve the minimal shape and defer:

* `TeamMember.isGuest Boolean @default(false)` — a guest membership: excluded from org-wide member listings available to plain members, **not** auto-added to the org default team, echoed as `"guest": true` on the team claim so consuming apps can gate.
* Invites gain nothing yet; `role_to_assign: "guest"` is rejected until the feature is built.
* Full guest semantics (what a guest may see inside the consuming product) stay a consuming-app concern, consistent with the custom-roles philosophy.

### 4.9 Role consistency & guard enforcement (G9)

Not new design — executing what `Docs/Research/api-changes-rebac.md §1/§4` already specifies, which this work depends on:

* Standardize team roles to `owner | admin | member`; migrate `lead` → `admin`; centralize the allowed set (today `team.service.base.ts` says `{member, lead}` while other services write `owner`).
* `requireOrgRole` (`middleware/org-role-guard.ts`) is currently called with **no role arguments** on every `/org/*` route (membership-only check); route registrations move to explicit tiers (`requireOrgRole('owner','admin')` on mutating endpoints) with inheritance per the rebac doc. The new lifecycle endpoints (§4.5) and invite-approval endpoints (§4.7) must launch with explicit tiers from day one.
* Membership checks everywhere add `status: ACTIVE` (a `DEACTIVATED` admin has no powers).

### 4.10 Audit log (G10)

New org-scoped audit table (the existing `AdminAuditLog` is platform-admin-scoped and keyed by email):

```prisma
model OrgAuditLog {
  id          String   @id @default(cuid())
  orgId       String   @map("org_id")
  actorUserId String?  @map("actor_user_id") // null = system (auto-enrolment, SCIM later)
  action      String   // "member.deactivated", "invite.approved", "team.join_policy_changed", …
  targetType  String   @map("target_type")   // "org_member" | "team_member" | "invite" | "invite_link" | "team"
  targetId    String   @map("target_id")
  metadata    Json     @default("{}")
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([orgId, createdAt])
  @@index([targetType, targetId])
  @@map("org_audit_log")
}
```

Written from every lifecycle/invite/policy mutation in the same transaction. Read endpoint (`GET /org/organisations/:orgId/audit-log`, owner/admin) can ship later; writing from day one is what matters. Finite retention like `LoginLog` (brief §22.8).

---

## 5. Token claim changes

Canonical shape stays `api-changes-rebac.md §5`. Deltas:

```jsonc
{
  "sub": "user_123",
  "email": "alice@acme.com",
  "method": "email",                     // now persisted via AuthIdentity (was spec-only)
  "active": {                            // NEW, optional — the workspace this session was opened for
    "orgId": "org_abc",
    "teamId": "team_xyz"
  },
  "orgs": [ /* unchanged, but ACTIVE memberships only; team claims may add "guest": true */ ]
}
```

* Memberships with `status != ACTIVE` never appear in claims.
* `active` present only when the login selected a team (§4.3/§4.4); absent otherwise — zero impact on existing consumers.
* Refresh re-resolves both `orgs` and `active` from DB (drops `active` if that membership is gone).

---

## 6. API surface deltas

Per CLAUDE.md, every row below also updates `API/src/routes/root/index.ts` (`/api` schema) and `API/src/routes/root/llm.ts`.

**New**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/start` | config | Email-first entry (alias/evolution of `/auth/register`) — sends link and/or code |
| POST | `/auth/verify-code` | config | Verify `LOGIN_CODE` → bridge token + team/invite list |
| POST | `/auth/select-team` | config + bridge token | Choose workspace / accept invite → policy checks → authorization code |
| POST | `/org/organisations/:orgId/members/:userId/deactivate` | dual (owner/admin) | Deactivate org membership |
| POST | `/org/organisations/:orgId/members/:userId/reactivate` | dual (owner/admin) | Reactivate |
| POST | `/org/organisations/:orgId/teams/:teamId/join` | dual (member) | Self-join `OPEN_TO_ORG` teams |
| POST | `/org/organisations/:orgId/teams/:teamId/invitations` | dual (role per `member_invites`) | Member-initiated invites (user-token variant of existing backend endpoint) |
| GET | `/org/organisations/:orgId/invitations?approval=pending` | dual (owner/admin) | List invites awaiting approval |
| POST | `/org/organisations/:orgId/invitations/:inviteId/approve` \| `/deny` | dual (owner/admin) | Approval decision |
| POST/GET/DELETE | `/org/organisations/:orgId/teams/:teamId/invite-links[…]` | dual (owner/admin) | Manage invite links |
| GET | `/auth/team-invite-link/:token` | public (rate-limited) | Invite-link landing |

**Changed**

| Path | Change |
|---|---|
| `POST /auth/login`, social callbacks, email-link landings | With `workspace_selection: "auto"`: return/land on chooser instead of finalizing directly |
| `POST /auth/token` | Response `firstLogin` unchanged; access token may carry `active`; refresh validates scoped membership |
| `DELETE /org/…/members/:userId` (org & team) | Soft-state transition instead of row deletion; semantics per §4.5 |
| Member/team list endpoints | `status` in responses; optional `include=invited` merge of pending invites; `HIDDEN` teams filtered |
| `PUT /org/…/teams/:teamId` | May set `joinPolicy` (owner/admin) |

---

## 7. Schema migration summary

One migration series, all additive except the two behavioural swaps (soft-delete, role enum):

1. `MembershipStatus` enum; `status` + `statusChangedAt` on `org_members`, `team_members` (backfill `ACTIVE`).
2. `auth_identities` table + backfill one `email` identity per user.
3. `LOGIN_CODE` in `VerificationTokenType`; `attempt_count` on `verification_tokens`.
4. `org_id`/`team_id` nullable on `authorization_codes`, `refresh_tokens`.
5. `TeamJoinPolicy` enum; `join_policy` on `teams` (backfill per §4.6); `is_guest` on `team_members` (default false, dormant).
6. `expires_at`, `approval_status`, `requested_by_user_id` on `team_invites` (backfill `NOT_REQUIRED`; existing pending invites get `expiresAt = lastSentAt + 30d`); `team_invite_links` table.
7. `org_audit_log` table.
8. Team-role normalization (`lead` → `admin`) — already specified by `api-changes-rebac.md §1`; sequenced here because §4.5/§4.7 endpoints depend on coherent tiers.

RLS: new tables follow the existing tenancy policies (`row-level-security.md`) — `auth_identities` keys off the owning user, `team_invite_links`/`org_audit_log` off org→domain, same as `team_invites`.

---

## 8. Security invariants (unchanged and re-asserted)

* **No enumeration**: `/auth/start` response is always generic; workspace names, membership existence, and invite lists are revealed **only after** the email is verified (code or link) — the same trust point at which today's `firstLogin` block reveals them. `verify-code` failures are generic and rate-limited; deactivated users see teams silently missing, never "you were suspended".
* **Generic errors** (brief §22.11) on every new endpoint, including invite-link failures and approval denials.
* Invite links authorize **joining, not authentication** — email verification always runs first.
* Bridge tokens (`login_token`) are short-lived, single-use, domain-bound — same class as the existing `twofa_token`.
* Codes: hashed at rest (existing `VerificationToken` hashing), 5-attempt cap, single active code, short TTL.
* No new secrets; no per-client secrets (brief §22.3 untouched); refresh tokens remain backend-only.
* Provider-verified emails only (brief §22.6) — `AuthIdentity.verifiedAt` records it, never bypasses it.

---

## 9. Flagged decisions & conflicts (per CLAUDE.md: raise, don't silently pick)

1. **Workspace = `Team`, not `Organisation` (recommended, assumed above).** Slack users belong to many workspaces; UOA enforces *one org per user per domain* (brief §24.3). Mapping workspace→Organisation would require breaking that invariant and the `org` claim shape. Mapping workspace→Team fits it: many teams per user, org auto-created around the first team (roles-and-acl.md), Enterprise-Grid ≈ multi-team org. If product direction instead wants true multi-org users per domain, that supersedes brief §24.3 and needs a brief amendment first.
2. **Numeric codes are opt-in.** The brief's flows are link-based; `email_code_enabled` defaults to `false` so no existing integrator changes. If codes should become the default someday, that's a brief update.
3. **Soft-delete replaces the brief §24.3 hard cascade.** Semantically equivalent for consumers (user disappears from rosters) but rows are retained. If any consuming product legally requires hard removal, keep the explicit admin hard-delete path; brief §24.3's wording ("delete records") should gain a clarifying note when this ships.
4. **Guests deferred** (§4.8) — channel-less guests are a product question for consuming apps; only the schema slot is reserved.
5. **Silent workspace-switch grant deferred** (§4.4) — re-run of the OAuth flow is the v1 switch mechanism.
6. **`INVITED` as data-derived, not a membership row** (§4.1) — deliberate divergence from Slack's placeholder accounts, for enumeration/RLS reasons.
7. **SCIM/SSO unchanged** — this design is a prerequisite for the deferred SCIM spec (soft-deprovision maps directly onto `DEACTIVATED`), not a modification of it.

---

## 10. Phasing

| Phase | Contents | Depends on |
|---|---|---|
| 1 | Migrations §7.1–2, §7.7–8; lifecycle filtering in claims/read paths; role-enum cleanup; audit writes | — |
| 2 | Deactivate/reactivate/remove semantics + scoped session revocation (§4.5) | 1 |
| 3 | `LOGIN_CODE` + `/auth/start` + `/auth/verify-code` + chooser + `/auth/select-team` + `active` claim (§4.3–4.4); `/Auth` UI for code entry + workspace chooser | 1 |
| 4 | Join policies + self-join + member-initiated invites + approval + invite expiry (§4.6–4.7) | 1, 2 |
| 5 | Invite links (§4.7) | 4 |
| — | Guests (§4.8), silent switch (§4.4), SCIM | product decision |

Each phase is independently shippable behind config defaults that preserve current behaviour (`email_code_enabled: false`, `workspace_selection: "off"`, `joinPolicy: INVITE_ONLY`, `member_invites: "allowed"` being the only default-on behavioural addition — set `"disabled"` at launch if zero behaviour change is required, then flip per product).

**Implementation housekeeping** (from code survey, must be respected while building): `token.service.ts` is at 542 lines — already over the 500-line cap — and gains the `active` claim + scoped-code logic, so Phase 3 starts by splitting it (e.g. `authorization-code.service.ts` / `access-token-issue.service.ts`); `team-invite.service.management.ts` (493) and `organisations.ts` route file (467) are near-cap and Phase 4 touches both — split before extending.
