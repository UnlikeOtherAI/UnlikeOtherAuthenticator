# Slack-Style Login & Membership Model — Design

> **Status:** Implemented. Phases 1–5 plus two follow-up rounds are merged to `main`
> (`d289a90..6a226ab`, see §10 for the phase-by-commit breakdown). This document has been revised
> post-implementation to match shipped behaviour — corrections and divergences from the original
> design are marked inline, with a summary in the new §12.
> **Date:** 2026-07-07
> **Implemented:** 2026-07-07 – 2026-07-09
> **Scope:** `/API` (schema, services, routes), `/Auth` (login flow UI), token claims
> **Inputs:** public-behaviour model of Slack (identity vs workspace membership), current UOA implementation
> **§11** adds the workspace-first UI specification (Auth window screens, sidebar/member-management contract for consuming apps)

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

  @@unique([userId, provider])
  @@index([userId])
  @@index([provider, providerSubject])
  @@index([email])
  @@map("auth_identities")
}
```

> **Shipped correction:** the uniqueness constraint is `@@unique([userId, provider])` (one identity row per provider per user — the upsert target), with a non-unique `@@index([provider, providerSubject])` for social-subject lookups. The design above originally specified a *global* `@@unique([provider, providerSubject])`, which was a design bug: under `user_scope: "per_domain"` the same email or social subject legitimately maps to separate `User` rows on different domains, and a global unique constraint would reject the second one and break the backfill. Verified against `API/prisma/schema.prisma` and migration `20260707104937_slack_membership_foundation`.

* Written on every successful login (upsert): social callbacks record the provider subject; email-link/code logins record an `email` identity. Existing behaviour (merge-by-verified-email, avatar overwrite per brief §22.7) is unchanged — this table *records* the merge instead of losing it.
* Backfill: create an `email` identity per existing user (`verifiedAt = User.createdAt`); password hash stays on `User` (it is a credential, not an identity).
* This gives the `method` claim (`api-changes-rebac.md §5`) a persistence home *in principle*, gives SCIM's `scimExternalId` a natural future sibling, and lets per-provider auto-enrolment (`VerificationMethod` matching) audit *which* identity satisfied the rule. **Shipped status:** `AuthIdentity` persistence itself shipped exactly as designed; the `method` access-token claim was not wired up to read from it — see §5 and §12b.

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
   * bridge token valid and unexpired; exact config URL + canonical verified parsed-config fingerprint, redirect, PKCE, remember-me, and request-access fields still match;
   * exact organisation and team memberships both exist with `status == ACTIVE` (or invite valid → accept via existing `acceptTeamInviteWithinTransaction`, which refuses `DEACTIVATED`/`REMOVED` tombstones);
   * team/org auth policy: resolve 2FA via existing `resolveTwoFaPolicy` for the *selected* org — may return a `twofa_token` challenge instead of completing;
   * `assertEmailDomainAllowedForLogin` (existing gate) still applies.
   Then `finalizeAuthenticatedUser` issues the authorization code, now carrying the selected team (§4.4), and a unique hashed JTI claims the chooser capability in the same transaction. `/auth/session-choices` and invite decline are deliberately non-consuming. ACTIVE scope is checked again at final code issuance after 2FA/signatures and at exchange.
4. Password login (`POST /auth/login`) and social callbacks route into the same selection step when `workspace_selection` is on: instead of finalizing immediately, they return the same `{ login_token, teams, pending_invites }` payload. With `workspace_selection: "off"` (default) nothing changes for existing integrators.

**`LOGIN_CODE` token type**: add to `VerificationTokenType`. Same table, hashed like link tokens, but: 6 digits, ~10-minute TTL, single active code per `(userKey, domain)` (issuing supersedes prior), and a new `attemptCount Int @default(0)` column on `VerificationToken` — max 5 verify attempts, then the code is dead and the user restarts. `POST /auth/verify-code` is IP- and email-key rate-limited via the existing `rate-limiter.ts` patterns, and failures return the standard generic error (brief §22.11). Magic-link flows are unaffected; codes are strictly additive.

**Magic links join the same flow**: the email-link landing (`/auth/email-*` routes) currently finalizes directly; when `workspace_selection` is on, a consumed link also lands on the chooser (the link *is* the verification). This keeps one canonical post-verification path: `verified identity → chooser → select-team → policy → code`.

### 4.4 Workspace-scoped sessions (G4)

Slack scopes the session to the chosen workspace. UOA's session objects gain optional team scope:

* `AuthorizationCode` + `RefreshToken`: add nullable `orgId` / `teamId` columns. Populated by `select-team`; null for flows with the chooser off (fully backward-compatible).
* Access-token claims: when a team was selected, add an `active` claim next to the existing org claims — `"active": { "orgId": "…", "teamId": "…" }`. **Shipped:** `active` sits next to the existing **legacy flat `org` claim** (`token.service.ts`'s `payload.org`), not an `orgs[]` array — the `api-changes-rebac.md §5` array-shape migration was not part of this work and remains deferred (see §5, §12b). `active` only says which workspace this session was opened for. Consuming apps that ignore it see no change.
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
* **Shipped enforcement covers the NEW mechanisms only.** `POST /org/organisations/:orgId/teams/:teamId/join` (self-join, `routes/org/team-self-join.ts`) enforces `OPEN_TO_ORG` in the service layer; `HIDDEN` teams are excluded from org-member-visible team listings (`team.service.teams.ts`: `NOT: { joinPolicy: 'HIDDEN' }` unless the caller is already an ACTIVE member of that team) and from the login chooser/self-join by the same rule. Both are built exactly as designed.
* **The gates on the two LEGACY mechanisms were deliberately NOT enforced.** Auto-enrolment (`org-placement`/`OrgEmailDomainRule` matching) is not gated on `APPROVED_DOMAIN`, and `AccessRequest` creation is not gated on `REQUEST_TO_JOIN`. Reason (documented in `access-request.service.auth.ts`): the access-request/auto-enrolment target team is named in the *signed config JWT*, and the foundation migration cannot reliably map those config targets onto teams to backfill the right `joinPolicy` value — enforcing the gate today would silently break existing auto-grant and request-to-join configs that predate this design. This is a deliberate deviation from the design above, raised per the non-breaking requirement; tracked in §12b as deferred work (needs a config-target→team mapping migration before it can be enforced).
* **Migration backfill — shipped scope is narrower than designed.** The shipped migration (`20260707140000_invite_lifecycle_and_member_invites`) backfills only: teams still at the `INVITE_ONLY` default with a non-empty `allowedEmailDomains` → `APPROVED_DOMAIN`. There is **no** `REQUEST_TO_JOIN` backfill (consistent with the gating deviation above — access-request target teams aren't reliably identifiable from data alone). All other teams keep the `INVITE_ONLY` default. Invites keep working under every policy (Slack's invitation path is always available).

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

* Standardize team roles to `owner | admin | member`; migrate `lead` → `admin`; centralize the allowed set (today `team.service.base.ts` says `{member, lead}` while other services write `owner`). Shipped: the `lead` → `admin` data backfill runs in migration `20260707104937_slack_membership_foundation`.
* `requireOrgRole` (`middleware/org-role-guard.ts`) is currently called with **no role arguments** on every `/org/*` route (membership-only check); route registrations move to explicit tiers (`requireOrgRole('owner','admin')` on mutating endpoints) with inheritance per the rebac doc. The new lifecycle endpoints (§4.5) and invite-approval endpoints (§4.7) must launch with explicit tiers from day one.
  **Shipped enforcement split (verified across `routes/org/*.ts`):** only `invitation-approvals.ts` was given the explicit tier — every route there calls `requireOrgRole('owner', 'admin')`. Every other org route (`teams.ts`, `organisation-members.ts`, `organisations.ts`, `team-invite-links.ts`, `team-self-join.ts`, `groups.ts`) kept the bare `requireOrgRole()` membership-only guard, with owner/admin tiers enforced in the **service layer** instead (e.g. `requireOrgManagerActor` in the lifecycle services) plus the `activeOnly` actor rule. The intent — mutating org actions require owner/admin — is met on every route; the *mechanism* differs by route (route-level guard vs. service-level check). Migrating the remaining routes to explicit route-level tiers is deferred, §12b.
* Membership checks everywhere add `status: ACTIVE` (a `DEACTIVATED` admin has no powers). Shipped as designed — confirmed in `getUserOrgContext`, the lifecycle services' `requireOrgManagerActor`/actor lookups, and `getTeam`'s hardcoded `status: 'ACTIVE'` filter on team member reads.

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

Written from every lifecycle/invite/policy mutation. **Shipped correction:** rows are written best-effort *after* the mutation's own transaction has committed, via `auditOrg` (`organisation.service.base.ts`) calling `writeOrgAuditLog` (`org-audit-log.service.ts`) against the BYPASSRLS admin client, wrapped in a try/catch that swallows failures — not in the same transaction as the mutation. This is deliberate: an audit-write failure must never roll back (or appear to roll back) a mutation that has already succeeded. (`writeOrgAuditLog` does accept a tenant tx client as an option for a same-transaction write, but no current caller passes one.) Read endpoint (`GET /org/organisations/:orgId/audit-log`, owner/admin) was not built — deferred, see §12b. Finite retention like `LoginLog` (brief §22.8) also not yet implemented.

---

## 5. Token claim changes

Canonical shape stays `api-changes-rebac.md §5` as the long-term target. **Shipped reality differs from the delta this section originally proposed** — verified in `token.service.ts`:

```jsonc
{
  "sub": "user_123",
  "email": "alice@acme.com",
  "domain": "acme.example.com",
  "org": { /* unchanged LEGACY flat shape — a single org context, as today */ },
  "active": {                            // NEW, optional — the workspace this session was opened for
    "orgId": "org_abc",
    "teamId": "team_xyz"
  }
}
```

* **(a) `active` shipped next to the legacy flat `org` claim, not the `orgs[]` array shape.** `token.service.ts`'s `signAccessToken` sets `payload.org` (singular, unchanged legacy shape) and, when a team was selected, `payload.active = { orgId, teamId }`. The `orgs[]`-array token-shape migration described in `api-changes-rebac.md §5` was **not** part of this work and remains unimplemented — it is listed as deferred in §12b. Treat the `orgs: […]` line in the original delta above as aspirational, not shipped.
* **(b) No `method` claim was added.** `AuthIdentity` persistence shipped as designed (§4.2), but nothing reads it back onto the access token — there is no `method` key anywhere in `token.service.ts`. Deferred alongside the `orgs[]` shape migration (§12b), since both belong to the same rebac token-shape change.
* Memberships with `status != ACTIVE` never appear in the (legacy) `org` claim — confirmed via the `getUserOrgContext`/`org-context.service.ts` ACTIVE-only filtering this claim is built from.
* `active` present only when the login selected a team (§4.3/§4.4); absent otherwise — zero impact on existing consumers. Confirmed shipped.
* Refresh re-resolves `active` from DB and drops it if that membership is gone, per design.

---

## 6. API surface deltas

Per CLAUDE.md, every row below also updates `API/src/routes/root/index.ts` (`/api` schema) and `API/src/routes/root/llm.ts`.

**New**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/start` | config | Email-first entry (alias/evolution of `/auth/register`) — sends link and/or code |
| POST | `/auth/verify-code` | config | Verify `LOGIN_CODE` → bridge token + team/invite list |
| POST | `/auth/select-team` | config + bridge token | Choose workspace / accept invite → policy checks → authorization code |
| POST | `/auth/session-choices` | config + bridge token | **Added in the follow-ups round** (`auth-session-choices.ts`, commit `9a39d77`), not originally listed here: hydrates the workspace-chooser payload (`login_token` → `{ teams, pending_invites, can_create_org }`) for redirect-based flows — the social callback is a GET redirect and cannot inline the JSON payload the way `/auth/login`/`/auth/verify-code` do, so the SPA calls this endpoint after landing to fetch it. Verifies the bridge token exactly like `/auth/select-team`; introduces no enumeration since it only ever answers for an already-verified `login_token`. |
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
| `POST /auth/login`, social callbacks, email-link landings | With `workspace_selection: "auto"`: return/land on chooser instead of finalizing directly. **Shipped and verified on all three paths** (originally the design's biggest open question): `login.ts` returns the chooser payload inline; social callbacks (`callback.ts`) redirect with a `login_token` + `flow=workspace_chooser` (hydrated via the new `/auth/session-choices`, above); and — landing last, in the gap-fix B round (commit `6a226ab`) — the magic-link paths: `GET /auth/email/link` (`email-registration-link.ts`) redirects the same `login_token`/`flow=workspace_chooser` way, and `POST /auth/verify-email` (`verify-email.ts`) returns the inline JSON chooser payload like `login.ts`. Invite-bound verification tokens (`teamInviteId` set) never see the chooser — the accepted invite *is* the selection. |
| `POST /auth/token` | Response `firstLogin` unchanged; access token may carry `active` next to the legacy `org` claim (§5); refresh validates scoped membership. Shipped as designed. |
| `DELETE /org/…/members/:userId` (org & team) | Soft-state transition instead of row deletion; semantics per §4.5. Shipped as designed. |
| Member/team list endpoints | **Shipped shape differs from this row's original wording.** `?status=` (`ACTIVE\|DEACTIVATED\|REMOVED\|all`, default `ACTIVE`) is wired on the **org** member list (`GET /org/organisations/:orgId/members`, `organisation-members.ts` + `MemberListQuerySchema`) but **not** on team member listing — the team-detail read (`GET /org/organisations/:orgId/teams/:teamId`) hardcodes `status: 'ACTIVE'` on its embedded `members[]` with no status query param. `include=invited` shipped, but as an **additive `invited: []` array**, not a merge into the existing member entries — see the §11.4/§11.5 correction below for its exact shape and gating. `HIDDEN` teams are filtered from team listings as designed. `?guests=` was **not** shipped — moved to deferred, §12b. |
| `PUT /org/…/teams/:teamId` | May set `joinPolicy` (owner/admin); may also set `icon_url` (§11.3) — both shipped. Org's `PUT /org/…/organisations/:orgId` similarly accepts `icon_url` and `member_invites`. |

---

## 7. Schema migration summary

One migration series, all additive except the two behavioural swaps (soft-delete, role enum):

1. `MembershipStatus` enum; `status` + `statusChangedAt` on `org_members`, `team_members` (backfill `ACTIVE`).
2. `auth_identities` table + backfill one `email` identity per user.
3. `LOGIN_CODE` in `VerificationTokenType`; `attempt_count` on `verification_tokens`.
4. `org_id`/`team_id` nullable on `authorization_codes`, `refresh_tokens`.
5. `TeamJoinPolicy` enum; `join_policy` on `teams` (backfill per §4.6); `is_guest` on `team_members` (default false, dormant); `icon_url` on `teams` and `organisations` (§11.3).
6. `expires_at`, `approval_status`, `requested_by_user_id` on `team_invites` (backfill `NOT_REQUIRED`; existing pending invites get `expiresAt = lastSentAt + 30d`); `team_invite_links` table.
7. `org_audit_log` table.
8. Team-role normalization (`lead` → `admin`) — already specified by `api-changes-rebac.md §1`; sequenced here because §4.5/§4.7 endpoints depend on coherent tiers.

RLS: new tables follow the existing tenancy policies (`row-level-security.md`). **Shipped correction:** `auth_identities` is **deny-all for `uoa_app`** (`REVOKE ALL ... FROM uoa_app` plus a `USING (false) WITH CHECK (false)` policy), not "keys off the owning user" — it is written and read only via the BYPASSRLS admin client, the same admin-managed classification as `admin_api_keys`, because it is sensitive and written pre/peri-context during authentication before a stable tenant context exists. `org_audit_log` does have org-scoped `INSERT`/`SELECT` policies for `uoa_app` (`org_id = current_setting('app.org_id')`) as designed, but — per the §4.10 correction above — production writes currently go through the BYPASSRLS admin client instead, so those policies are exercised only if/when a caller opts into the tenant-tx write path. Both verified in migration `20260707104937_slack_membership_foundation`.

---

## 8. Security invariants (unchanged and re-asserted)

* **No enumeration**: `/auth/start` response is always generic; workspace names, membership existence, and invite lists are revealed **only after** the email is verified (code or link) — the same trust point at which today's `firstLogin` block reveals them. `verify-code` failures are generic and rate-limited; deactivated users see teams silently missing, never "you were suspended".
* **Generic errors** (brief §22.11) on every new endpoint, including invite-link failures and approval denials.
* Invite links authorize **joining, not authentication** — email verification always runs first.
* Bridge tokens (`login_token`) are short-lived and single-use. They bind subject/domain, exact config URL, a canonical fingerprint of verified parsed config semantics, selected redirect, PKCE challenge/method, remember-me, request-access, expiry, and JTI. Only the SHA-256 JTI digest is stored in the admin-only replay ledger.
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

All phases below are merged to `main`. Commit hashes verified via `git log --oneline d289a90..HEAD`.

| Phase | Contents | Depends on | Landed |
|---|---|---|---|
| 1 | Migrations §7.1–2, §7.7–8; lifecycle filtering in claims/read paths; role-enum cleanup; audit writes | — | `d289a90` — "Slack membership Phase 1: lifecycle foundation, auth identities, audit log" |
| 2 | Deactivate/reactivate/remove semantics + scoped session revocation (§4.5) | 1 | `90f1b3f` — "Slack membership Phase 2: member lifecycle + fix nested-transaction bug" (also fixed a pre-existing nested-transaction bug blocking the whole `/org/*` route surface — §12a) |
| 3a | Session/token foundation for workspace login (schema/service groundwork for the chooser) | 1 | `0db3d69` — "Slack membership Phase 3a: session/token foundation for workspace login" |
| 3b | `LOGIN_CODE` + `/auth/start` + `/auth/verify-code` + chooser payload + `active` claim (§4.3–4.4) | 3a | `6ef0bcf` — "Slack membership Phase 3b: email sign-in codes + workspace selection" |
| 3c | `/auth/select-team` + `/Auth` UI for code entry + workspace chooser | 3b | `0af241d` — "Slack membership Phase 3c: Auth window code entry + workspace chooser" |
| 4 | Join policies + self-join + member-initiated invites + approval + invite expiry (§4.6–4.7) | 1, 2 | `051bd78` — "Slack membership Phase 4: team join policies + invite upgrades" |
| 5 | Invite links (§4.7) | 4 | `1b545e4` — "Slack membership Phase 5: shareable team invite links" |
| follow-ups | Social→chooser wiring (`/auth/session-choices`), `login_token` audience fix, oversized-file test splits | 3c | `9a39d77` |
| gap-fix A | `/org/me` sidebar contract (`workspaces[]`/`pending_invites[]`), `include=invited`, `icon_url` wiring | 1–5 | `a47aa45` |
| gap-fix B | Magic-link→chooser (both landing paths), `team_hint`, social→chooser PKCE fix | gap-fix A | `6a226ab` (HEAD) |
| — | Guests (§4.8), silent switch (§4.4), SCIM | product decision | not started (deferred, §12b) |

Original design phasing described Phase 3 as a single unit; it shipped split into 3a/3b/3c, each independently committed. Each phase was independently shippable behind config defaults that preserve current behaviour (`email_code_enabled: false`, `workspace_selection: "off"`, `joinPolicy: INVITE_ONLY`, `member_invites: "allowed"` being the only default-on behavioural addition — set `"disabled"` at launch if zero behaviour change is required, then flip per product).

**Implementation housekeeping** (from the original code survey; now resolved). The design flagged `token.service.ts` (542 lines, over the 500-line cap) and near-cap `team-invite.service.management.ts` (493) / `organisations.ts` (467) as needing a split before Phase 3/4 extended them. Verified post-implementation (`wc -l`): `token.service.ts` is now 381 lines, with the authorization-code and access-token concerns split out into `authorization-code.service.ts` (232) and `access-token.service.ts` (127); `team-invite.service.management.ts` is 277 lines, with invite sub-concerns split across `team-invite.service.invited.ts`, `.resend.ts`, `.token.ts`, `.acceptance.ts`, `.base.ts`, `.member.ts`; `organisations.ts` is 193 lines, with member routes split into `organisation-members.ts` (254). No touched file in this workstream exceeds the 500-line cap.

---

## 11. Workspace-first UI specification

The governing UX rule: **a user never logs into "the product" — they enter a specific workspace.** Identity verification is global; everything after it is scoped to the workspace the user selects. This section specifies where each piece of that experience lives and what UOA must provide for it.

### 11.1 Ownership boundary — who renders what

UOA is an auth service consumed by products; it does not render the product. Three surfaces:

| Surface | Owner | Renders |
|---|---|---|
| **Auth window** (`/Auth`, OAuth popup) | UOA | Sign-in → identity verification → **workspace chooser** → invite accept/decline → 2FA → redirect with a workspace-scoped code. This is where the Slack-style login lives. |
| **Consuming product** | Client app | Sidebar with workspace icon stack, channels, in-app member management, workspace settings, billing, integrations. UOA powers these with the `/org/*` API, token claims, and the switch flow — it does not render them. Channels remain entirely the product's data. |
| **UOA Admin** (`/Admin`) | UOA | Operator views only (domains, integrations, platform superusers). Workspace admins are *product* users and never see this panel. Operator-facing org/member browsing over `/internal/admin/*` may adopt the same status vocabulary later, but is not part of this design. |

Everything the consuming product needs to feel "workspace-first" must therefore be expressible through **data** (claims, endpoints, statuses, icons) — that contract is §11.4.

### 11.2 Auth window flow & screens

Extends the state-driven flow in `architecture-auth.md §Auth Flow Navigation`. New steps in bold:

```
Entry (config loaded)
  → LoginPage / RegisterPage            (email-first; password & social per enabled_auth_methods)
  → identity verification               (password | social | email link | NEW: email code)
  → **WorkspaceChooserPage**            (when workspace_selection: "auto")
       ├─ workspace list (ACTIVE memberships)
       ├─ pending invite cards (accept / decline)
       └─ "Create a new workspace" (iff can_create_org)
  → TwoFactorVerify / TwoFactorSetup    (policy of the SELECTED org — unchanged components)
  → Redirect with authorization code (team-scoped)
```

The chooser is skipped automatically (straight to policy + redirect) when the user has exactly one
active team and no pending invites, or when `workspace_selection: "off"`. New/empty users with
`can_create_org` stay on the chooser so the create-workspace entry remains reachable. An
invite-bound email is already a selection: its accepted org/team bypasses the chooser but still
passes through the effective 2FA policy before the scoped code is issued. The existing `firstLogin`
precedence rules (brief §24.14) drive the remaining empty/invite states.

**New pages** (one per file, per `architecture-auth.md` rules):

* `CodeEntryPage.tsx` — "We sent a code to `{email}`" + 6-digit input. Reuses the `TwoFactorInput` 6-digit component pattern (extract the digit-boxes primitive to `/ui/CodeInput.tsx` and let `TwoFactorInput` wrap it rather than duplicating). Resend link (rate-limited), generic failure copy.
* `WorkspaceChooserPage.tsx` — the Slack "choose a workspace" screen.

**New components** (`/components/workspace/`):

* `WorkspaceList.tsx` — vertical stack of `WorkspaceCard`s, ordered by most-recent login (server provides order), then alphabetical.
* `WorkspaceCard.tsx` — icon + name + secondary line (org name when it differs from the team name; the user's role only when `owner`/`admin`). Icon = `iconUrl` if set, else deterministic initials-on-color fallback (§11.3). Entire card is the button.
* `InviteCard.tsx` — visually distinct pending card: *"You've been invited to **{team}**"*, secondary line *"Invited by {invitedByName} ({invitedByEmail}) · expires {date}"*, **Accept** (primary) and **Decline** (quiet/secondary) actions. Accept continues into that workspace's policy checks (§4.3); Decline removes the card in place and stays on the chooser.
* `CreateWorkspaceCard.tsx` — rendered only when `can_create_org: true`; posts to the existing `POST /org/organisations` and continues into the new workspace.

All styling stays theme-config-driven (no Slack visuals hardcoded); all copy goes through i18n keys.

**Copy rules** (i18n keys, enforced in review): headings and buttons name the *workspace*, not the product — "Open **Backend Team**", "You're entering **Acme Engineering**" — and the chooser heading is "Choose a workspace" / "Your workspaces for `{email}`". The only product-named moment is the initial email screen (which is client-branded via `ui_theme` anyway).

### 11.3 Workspace visual identity

Slack's icon/name stack needs an icon per workspace; `Team` (and `Organisation`) currently have none.

* Add `Team.iconUrl String? @map("icon_url")` and `Organisation.iconUrl String?` — **external URL only**, same policy as user avatars (brief §15: no local storage; stored and served as-is). Settable via existing `PUT` team/org endpoints (owner/admin) and echoed everywhere teams are listed (chooser payload, `/org/me`, member/team lists, `firstLogin`). **Shipped as designed** — verified: `PUT /org/organisations/:orgId/teams/:teamId` and `PUT /org/organisations/:orgId` both accept `icon_url` (`routes/org/teams.ts`, `routes/org/organisations.ts`); it is echoed on `firstLogin`'s team memberships (`first-login.service.ts`'s `FirstLoginMembershipTeam.iconUrl`), the chooser (`WorkspaceChoiceTeam.iconUrl`), and `GET /org/me`'s new `workspaces[]` entries (`workspace-directory.service.ts`'s `WorkspaceEntry.iconUrl`) — all landed in gap-fix A (commit `a47aa45`).
* Fallback is client-side and deterministic: initials of the team name on a background color picked by hashing `teamId` into the theme palette — no stored color column, identical across sessions and across the Auth window and consuming products (documented so products can replicate it).

### 11.4 Consuming-product contract (sidebar, switching, member management)

**Workspace context.** The `active` claim (§5) is the product's source of truth for "which workspace am I in". Products render workspace-scoped UI (channels, settings, roles, billing, integrations) off `active.teamId`/`active.orgId` and gate role-specific actions off that team's `uoaRole`/`customRole` claims — never off user-global state.

**Sidebar workspace stack.** `GET /org/me` is extended to return, per membership: `teamId`, `orgId`, `name`, `orgName`, `slug`, `iconUrl`, `role`, `status`, `lastLoginAt` (from `LoginLog`, for ordering) — plus a top-level `pending_invites` array (same card data as the chooser). The sidebar is a straight render of this response: active workspace highlighted, others one click away, invite badges surfaced. Statuses other than `ACTIVE` are never returned here (a deactivated workspace simply disappears from the stack).

> **Shipped shape (gap-fix A, commit `a47aa45`; verified in `routes/org/me.ts` and `services/workspace-directory.service.ts`):** the response gains two new **top-level, additive** fields alongside the existing org-context payload — `workspaces: WorkspaceEntry[]` and `pending_invites: SidebarPendingInvite[]` — rather than the existing per-membership fields being extended in place. Each `WorkspaceEntry` carries `teamId`, `orgId`, `name`, `slug`, `orgName`, `iconUrl`, `role`, `lastLoginAt`. There is **no explicit `status` key** on each entry: `buildSidebarWorkspaces` only ever queries `status: 'ACTIVE'` team memberships, so (as the paragraph above already promises) a non-`ACTIVE` workspace is omitted outright rather than returned with a status label. `lastLoginAt` is derived from `max(createdAt)` of the caller's own scoped `refresh_tokens` rows for that `(userId, domain, teamId)` — not from `LoginLog` as originally guessed — and is `null` for a workspace never opened with a team-scoped session; ordering is `lastLoginAt` DESC (nulls last) then `name` ASC. `pending_invites[]` entries are `{ inviteId, teamId, teamName, invitedBy, expiresAt }`, using the same `pendingInviteStatusWhere` eligibility filter as the chooser (`first-login.service.ts`).

**Switching.** Clicking another workspace re-runs the OAuth flow with a new entry hint: `GET /auth?...&team_hint=<teamId|slug>`. Because the Auth window still holds a verified identity context, the chooser is skipped and `select-team` runs directly for the hinted team (falling back to the chooser if the hint is invalid or the membership isn't `ACTIVE`) — one click, no re-typing. This is the v1 mechanism; the silent server-side switch grant stays deferred (§4.4, §9.5). `team_hint` also serves as UOA's equivalent of Slack's per-workspace URL: a product can deep-link `app.example.com/w/backend` straight into that workspace's sign-in.

> **Shipped as designed** (gap-fix B, commit `6a226ab`): `entrypoint.ts` accepts `team_hint` (id or slug) on `GET /auth` and silently strips an invalid one server-side (`sanitizeTeamHintInUrl`) before it reaches the SPA's bootstrap state; the SPA does the actual preselection client-side (`pickHintTeam`, matched against the verified user's own chooser payload — the same code path as the existing single-team auto-skip). `select-team`'s ACTIVE-membership + domain validation remains the sole server-side authority, exactly as designed — `team_hint` is a UX shortcut, never a trust boundary.

**Member management area** (rendered by the product; workspace owner/admin only). One screen, five tabs, each already backed by this design — no additional endpoints beyond §6:

| Tab | Source | Row actions (role-gated) |
|---|---|---|
| **Active** | `GET .../teams/:teamId` members with `status=ACTIVE` | change role, remove (§4.5), deactivate |
| **Invited** | member list with `include=invited` (pending `TeamInvite`s, §4.1) — shows email, invited-by, sent/expires dates, open tracking | resend, revoke; approve/deny sub-list when `member_invites: "admin_approval"` |
| **Guests** | members with `isGuest=true` (§4.8 — tab ships empty/hidden until guests are enabled) | remove |
| **Deactivated** | members with `status=DEACTIVATED` | reactivate, remove |
| **Requests** | existing `GET /org/organisations/:orgId/access-requests` (`REQUEST_TO_JOIN` teams) | approve, reject |

> **Shipped shapes, verified per row:**
> - **Active** — `getTeam` (`team.service.teams.ts`) hardcodes `members: { where: { status: 'ACTIVE' } }` on the team-detail read; there is no `?status=` query param on this endpoint (it's always ACTIVE-only), so the "Deactivated" tab below cannot literally reuse this same endpoint with a different query value — see the Deactivated row correction.
> - **Invited** — shipped, but as an **additive `invited: []` array** on `GET /org/organisations/:orgId/teams/:teamId?include=invited` (exact literal; any other value is ignored, not rejected), gated to org/team owner/admin — a plain member gets `invited: []` rather than a 403. Entry shape (verified in `routes/root/schema.ts` and `team-invite.service.invited.ts`): `{ inviteId, email, inviteName, teamRole, invitedByName, invitedByEmail, lastSentAt, expiresAt, approvalStatus, openCount }`. Gap-fix A, commit `a47aa45`.
> - **Guests** — shipped exactly as designed: dormant, `isGuest` defaults `false`, no UI/endpoint work beyond the schema slot (§4.8, §12b).
> - **Deactivated** — the design's `status=` query param is **not** wired on the team-member read (see Active row above); it **is** wired on the org-level member list (`GET /org/organisations/:orgId/members?status=DEACTIVATED`, `organisation-members.ts`). A product building this tab off team-scoped data needs a different query shape than this table implies — flagged as a gap, §12b.
> - **Requests** — unchanged, shipped pre-existing.

Plus an "Invite people" action (the §4.7 user-facing invite endpoint) and the team's `joinPolicy` selector in workspace settings. **Shipped correction:** `?status=` is wired only on the **org** member list endpoint (default `ACTIVE`, accepts `ACTIVE|DEACTIVATED|REMOVED|all`), not on team member listing (see above). `?guests=` was **not** shipped on any list endpoint — moved to deferred, §12b. `include=invited` shipped as described above, scoped to the team-detail read only.

**Global vs workspace-scoped settings.** The dividing line products must respect (and UOA's data model enforces):

| Global (the person) | Workspace-scoped (the membership) |
|---|---|
| email, name, pronouns, avatar, password, 2FA enrollment, linked auth identities | role (`uoaRole`/`customRole`), invites, guests, join policy, member management, audit log — and the product's own channels, billing, integrations |

UOA holds nothing workspace-scoped on `User` and nothing personal on memberships, so a product cannot accidentally leak settings across workspaces by following the API shape.

### 11.5 API/schema addenda introduced by this section

Deltas on top of §6/§7 (each also mirrored in `/api` + `/llm` per CLAUDE.md):

1. `POST /auth/select-team` accepts `{ login_token, inviteId, action: "accept" | "decline" }` — decline (Slack's invite-card Decline) marks the invite declined via the existing `declineTeamInviteByToken` logic, authenticated by the bridge token instead of the emailed token, and returns the refreshed chooser payload. **Shipped as designed**, verified in `routes/auth/auth-select-team.ts` (also gained an `inviteLinkToken` variant in Phase 5 for invite-link joins, not originally specced here).
2. `GET /auth` gains optional `team_hint` query param (chooser preselect / skip; ignored when invalid). **Shipped** — gap-fix B, commit `6a226ab` (see §11.4 correction above for the exact mechanism: server-side sanitize-or-strip, client-side preselect only).
3. `GET /org/me` enrichment: `orgName`, `iconUrl`, `status` filtering, `lastLoginAt` ordering, `pending_invites[]`. **Shipped shape differs** — gap-fix A, commit `a47aa45`: additive top-level `workspaces[]` (with `orgName`, `iconUrl`, `lastLoginAt`, but no explicit `status` key — filtering happens by omission, ACTIVE-only) plus top-level `pending_invites[]`. See the full correction in §11.4.
4. Member list endpoints: `?status=`, `?guests=`, `include=invited` filters (formalizing §6). **Shipped scope is narrower**: `?status=` on the org member list only (not team); `include=invited` on the team-detail read only, as an additive array; `?guests=` not shipped. See §6/§11.4 corrections and §12b.
5. Schema (added to migration step 5 in §7): `icon_url` on `teams` and `organisations`. **Shipped as designed**, migration `20260707104937_slack_membership_foundation`.
6. `/Auth` additions: `CodeEntryPage`, `WorkspaceChooserPage`, `/components/workspace/*`, `/ui/CodeInput.tsx` — `Docs/Auth/architecture-auth.md`'s directory tree and flow list must be updated in the implementation PR that adds them. **Shipped** across Phase 3b/3c (commits `6ef0bcf`, `0af241d`); gap-fix B additionally touched `Auth/src/hooks/use-popup.tsx` and `WorkspaceChooserPage.tsx` for `team_hint`/session-choices hydration.

Phasing: items 1–2 and the new pages land with **Phase 3** (they are the chooser); item 3–4 with **Phase 2** (lifecycle read surface) — in practice items 3–4's final shapes landed with the gap-fix A/B rounds, after Phase 2's initial `?status=`/lifecycle work; item 5 with **Phase 1** (trivial additive columns).

---

## 12. Implementation notes & deferred work

This section was added post-implementation to record what the code survey and gap-fix rounds turned up that the original design (§1–§11) either didn't anticipate or got only partly right. It does not change any decision above; §1–§11 have been corrected in place where reality diverged, and this section is the index of those corrections plus the runtime bugs found along the way.

### 12a. Notable implementation findings

1. **Pre-existing nested-transaction bug, found and fixed in Phase 2 (`90f1b3f`).** The RLS rollout (prior to this design) made every `/org/*` and `/internal/org/*` route run its service call inside `request.withTenantTx` — an interactive transaction — and pass that transaction client down as `deps.prisma`. Several services then called `prisma.$transaction(...)` again on that same client, but a Prisma `TransactionClient` has no `$transaction` method, so every org/team mutation threw `"prisma.$transaction is not a function"` at runtime. This had been latent: CI ran no integration tests against a real database, and unit tests mocked `$transaction` away. Fixed by adding `runInTransaction(client, body)` to `db/tenant-context.ts` — it opens a real interactive transaction for a full client (unchanged behaviour) and runs the body directly when already inside a tenant transaction (the nested case). All callback-form `$transaction` call sites across the touched services were converted to it. Without this fix, the entire Phase 2+ lifecycle feature set would have been broken over HTTP despite passing unit tests.
2. **`login_token` audience mismatch, found and fixed in the follow-ups round (`9a39d77`).** `login.ts` originally signed the chooser-branch `login_token` bridge JWT using `getAuthServiceIdentifier()` as the audience, but `verify-code`/`select-team`/`session-choices` all verify it against `LOGIN_SESSION_AUDIENCE`. A password-login `login_token` therefore failed `verifyLoginSession` at `select-team` — the password→chooser flow was broken end to end. Fixed by switching `login.ts` to sign with `LOGIN_SESSION_AUDIENCE` (the unrelated `twofa_token` bridge continues to use the auth-service identifier — unaffected). A regression assertion was added to the login-chooser route test, and a DB-backed round-trip confirms the old audience fails verification while the new one succeeds.
3. **Social→chooser PKCE omission, found and fixed in gap-fix B (`6a226ab`).** `callback.ts`'s `workspace_chooser` redirect branch initially omitted `code_challenge`/`code_challenge_method`, breaking eventual code issuance. The redirect now forwards both for the Auth UI. The chooser capability additionally signs PKCE itself, so URL forwarding is transport only and caller retargeting is rejected.
4. **Chooser continuation/replay hardening (2026-07-19).** The original `login_token` signed only `{ sub, domain }`, allowing a valid bridge to be replayed or paired with another allowlisted redirect/PKCE/config continuation. It now signs every security-relevant continuation field plus a canonical parsed-config fingerprint and JTI. A unique admin-only `login_session_uses` row stores only the hashed JTI and is inserted last in the final-selection transaction, rolling back a concurrent replay's speculative invite/code work. Choices and decline remain non-consuming.
5. **Existing-user link and membership tombstone hardening (2026-07-19).** `LOGIN_LINK` is now consumed only for its issue-time existing `userId`; it never creates a replacement user. Personal invite acceptance and same-user accepted replay require exact ACTIVE org + team membership and never reactivate `DEACTIVATED`/`REMOVED` rows. Scoped issuance and exchange revalidate that invariant, closing membership-change TOCTOU across 2FA/signatures.

### 12b. Deferred / follow-up backlog

- **Guests** (§4.8) — schema slot (`TeamMember.isGuest`) shipped and dormant; no invite/list/UI work built. Includes the `?guests=` list filter, not shipped on any endpoint.
- **Silent workspace-switch grant** (§4.4) — re-running the OAuth flow (with `team_hint` for a one-click chooser skip) is the only switch mechanism; a token-level silent switch grant was never built, per the design's own deferral.
- **`method` claim + `orgs[]` token shape** (`api-changes-rebac.md §5` migration) — `AuthIdentity` persistence shipped, but nothing reads it back as a `method` claim; the access token still carries the legacy flat `org` claim, not an `orgs[]` array. Both remain part of the separate, unimplemented rebac token-shape migration (§5).
- **Join-policy gating of the legacy mechanisms** (§4.6) — `APPROVED_DOMAIN` auto-enrolment and `REQUEST_TO_JOIN` access-request creation are not gated on `joinPolicy`; only the new `OPEN_TO_ORG` self-join and `HIDDEN` listing/discovery paths enforce it. Needs a migration that can map signed-config access-request/domain-mapping targets onto teams before the legacy mechanisms can be safely gated without breaking existing configs.
- **Org audit-log read endpoint** (§4.10) — `GET /org/organisations/:orgId/audit-log` was never built; writes (best-effort, post-commit, via the admin client) are the only shipped half of G10.
- **Explicit guard tiers on remaining org routes** (§4.9) — only `invitation-approvals.ts` uses route-level `requireOrgRole('owner','admin')`; every other org route still uses the bare `requireOrgRole()` with the owner/admin check pushed into the service layer. Functionally equivalent, but the rebac doc's route-level-tier migration for the remaining routes was not done.
- **SCIM** (`roles-and-acl.md`) — unchanged; this design remains its prerequisite (soft-deprovision maps onto `DEACTIVATED`), not a modification of it.
- **`?status=` on team member listing** — the org member list supports `?status=`; the team-detail read's embedded `members[]` does not (hardcoded to `ACTIVE`). Not called out as deferred in the original design because the design didn't distinguish the two list surfaces; flagged here after the code survey (§6, §11.4).
- **Finite retention on `org_audit_log`** (§4.10, "like `LoginLog`, brief §22.8") — not implemented; rows accumulate with no pruning job.
