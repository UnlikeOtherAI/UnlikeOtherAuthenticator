# Account portal — `/account`, the user-facing home for identity, organisations and teams

> **Status:** design, 2026-09-03. Nothing below is implemented. Written from the
> live `/api` contract and the source on `main` at `31d0faf`; every "exists"
> claim was verified in code, every "new" item is marked **NEW**.
>
> **The ask, in the owner's words:** *"I guess we should do it on the
> UnlikeOtherAuthenticator as an alternative option because it's an SSO. If I
> have an account in there, I should be able to go to the SSO URL, but instead
> of /admin, I'm gonna go to /account. There, if I log in, I should be able to
> manage everything regarding my account: just create, manage organisations,
> teams, where I am, just the user-facing stuff. Change a password."*
>
> **Why now:** Nessie just fixed a bug where renaming an organisation wrote a
> local mirror instead of relaying to UOA. UOA is the authority for identity,
> organisations and teams; rather than every product growing its own
> org-management UI, UOA itself offers the user-facing home for it.

## The one-paragraph design

`/account` is a third first-party React app served by the API from the auth
origin, exactly as `/admin` is. It signs a person in through UOA's own OAuth
flow against a second first-party config JWT (`GET /account/config`, PKCE,
`POST /account/token`), holds a short-lived access token in `sessionStorage`,
and then drives the **existing user-mode `/org/*`, `/avatar/me` and `/2fa/*`
endpoints** — the same endpoints every product backend calls — through one new
**first-party bearer lane** that stands in for the domain-hash credential a
browser must never hold. It adds six small endpoints UOA does not have today:
a session read that returns the person's whole cross-product directory with
server-resolved capabilities, a display-name write, a signed-in password
change, a sign-out-everywhere, and user-mode invitation accept/decline. Every
control on every screen is shown, enabled, or replaced by an explanation
according to the capability the server reports for that person in that
organisation or team, and the server refuses independently.

## 1. Scope and non-scope

### In scope

- Sign in / sign out at `/account`, with any account UOA holds (never
  `system_admin`, never Google-only).
- "Where I am": every organisation and team the person is an ACTIVE member of,
  across every product domain, with their role in each and their pending
  invitations.
- Organisation: create, rename, icon URL, member-invite policy, members
  (list, change role, remove, deactivate/reactivate), teams, pending
  member-invite approvals, transfer ownership, delete.
- Team: create, rename, slug, description, join policy, icon URL, uploaded
  avatar, members (add from the org, change role, remove), invitations
  (create, list, resend, revoke), invite links (create, list, revoke), access
  requests (approve/reject), self-join of `OPEN_TO_ORG` teams.
- Invitations addressed to me: accept, decline.
- Profile & security: display name, avatar, email (read-only), password change,
  set-a-password for social-only accounts, 2FA enrol/disable, sign out
  everywhere.

### Not in scope, and why

| Not this | Why |
| --- | --- |
| **The admin panel.** No domain, tariff, superuser, log, ban, flag or Stripe surface. | Those are `/internal/admin/*`, gated on `SUPERUSER` for `ADMIN_AUTH_DOMAIN`. The account portal never sends an admin token and its token cannot pass `requireAdminSuperuser` (§4.4). |
| **Managing other people's identities.** No user search, no "add member by id" at org level, no editing another person's name/email/2FA. | The API grants a member exactly the org/team capabilities of `Docs/plans/2026-08-16-configurable-roles-and-capabilities.md`; people join organisations through **team invitations** (email) or invite links, which is the only user-facing way UOA already has to name a person who is not yet a member. `POST /org/organisations/:orgId/members` takes a `user_id`, which a person cannot know; it stays a backend affordance. |
| **Billing.** No credits, statements, top-ups, invoices. | Every `/billing/v1/*` customer route authenticates with **the requested product's** `customer_lifecycle` `X-UOA-App-Key` plus a product-signed `X-UOA-Actor` assertion (`/api`), and a statement is per product × team. UOA has no product-neutral customer billing view and no first-party app key; the org-wide override (`2026-08-15-org-billing-override.md`) is still rendered *by products*. Building a first-party billing surface means minting an "account" billing service + app key and re-deriving the statement protocol client — a separate design, not a tab. Products keep `/tokens`. |
| **Email change.** | Email is the canonical identifier (brief §2, §4); no change flow exists anywhere (SCIM even rejects `userName` changes). Shown read-only. |
| **Account deletion, custom (product) roles, groups, feature flags, SCIM.** | No user-facing endpoint exists for any of them; groups are `groups_enabled: false` with zero consumers; custom roles are product-defined labels UOA stores but does not interpret. |
| **Creating an access request** (`REQUEST_TO_JOIN` teams). | Access requests are created only inside a product login with `request_access`; there is no user-mode create endpoint. Phase 4 candidate (§11). |

## 2. What already exists (verified 2026-09-03)

| Concern | Where | Reused as |
| --- | --- | --- |
| The whole user-mode org API | `API/src/routes/org/*` — `GET /org/me`, org CRUD, members, transfer-ownership, teams, team members, invitations, approvals, invite links, self-join, access requests, team avatar | Unchanged contracts; the portal is a **user-mode** client. Contract of record: `curl -s https://authentication.unlikeotherai.com/api` |
| Capability gates | `API/src/services/role-grants.ts` (`members.manage`, `teams.manage`, `organisation.manage`, `LEGACY_DEFAULT_ROLE_GRANTS`), `requireOrgCapability` (`organisation.service.base.ts`), `hasWorkspaceCapability` / `requireWorkspaceCapability` (`team.service.base.ts`) | The server side of every control. `GET /account/me` resolves the same functions for the UI (§6). |
| First-party OAuth precedent | `Admin/src/features/auth/admin-oauth.ts` (PKCE S256, `/auth?config_url=&redirect_url=&code_challenge=`), `admin-session-storage.ts`, `admin-session.ts`, `services/api-client.ts` (same-origin guard) | Copied shape for `/account` (§4). |
| First-party config + token | `API/src/services/admin-auth-config.service.ts` (`ADMIN_CONFIG_JWT`, `assertAdminConfigPolicy`), `API/src/routes/internal/admin/config.ts`, `/internal/admin/token.ts` (`exchangeAuthorizationCodeForTokens`, access token only, no refresh), `token.service.ts` `resolveAccessTokenContext` (admin domain ⇒ `ADMIN_ACCESS_TOKEN_SECRET`, `client_id = admin:<domain>`) | Mirrored (§4.2–§4.3); one change to `resolveAccessTokenContext` (§4.4). |
| Serving a SPA from the API origin | `API/src/routes/admin-ui.ts` + `services/admin-ui.service.ts` (`/admin/assets/*` immutable, `/admin/*` SPA fallback, `Admin/dist` built in `Dockerfile`, Vite `base: '/admin/'`) | Parameterised and shared (§4.6). |
| Revocation model | `User.tokenVersion` (`tv` claim, checked on every `verifyAccessToken`), refresh-token families, `revokeAllRefreshTokensForUser` (revokes every family **and** bumps `tokenVersion` under the user-global lock), `lockAndAssertGlobalAuthenticationEpoch` | Password change and sign-out-everywhere (§9.4–§9.5). |
| Password reset | `POST /auth/reset-password/request` (no enumeration, timing-equalised), `POST /auth/reset-password` (token), `password.service.ts` (`argon2id`, `MIN_PASSWORD_LENGTH = 8`, `verifyPassword` with dummy hash) | "Set a password" for social-only accounts; hashing/verification for change (§9.4). |
| Self-service 2FA | `POST /2fa/setup`, `/2fa/enroll`, `/2fa/disable` (`configVerifier` + `X-UOA-Access-Token`), `resolveTwoFaPolicy` | Security screen (§5.8), with one policy widening (§9.6). |
| Avatars | `GET/PUT/DELETE /avatar/me` (dual auth), `GET /domain/users/:userId/avatar`, `/org/…/teams/:teamId/avatar`, public `/teams/:teamId/avatar`, `Docs/Auth/avatars.md` §9/§11 | Profile avatar, member tiles, team tiles. |
| Workspace directory | `workspace-directory.service.ts` `buildSidebarWorkspaces` (cross-product branch under `all_active_memberships`), `buildSidebarPendingInvites`, `first-login.service.ts` | `GET /account/me` (§9.1). |
| Invitation accept/decline for a signed-in person | `team-invite.service.acceptance.ts` `acceptTeamInviteWithinTransaction` / `declineTeamInviteForUser` — today reachable only through the pre-token `POST /auth/select-team` bridge and backend-mode accept | New user-mode routes (§9.7). |
| The look | `Auth/src/theme/*` (`--uoa-color-*`, `--uoa-radius-*` from `ui_theme`), `Auth/src/components/ui/*`, `Auth/src/components/workspace/{WorkspaceList,WorkspaceCard,OrgSectionHeader,InviteCard}.tsx`, `Auth/src/utils/workspace-icon.ts` | Extracted into a shared package and used verbatim (§7). |

Three facts that shape the design more than any other:

1. **Every `/org/*` route requires the domain-hash bearer** (`Authorization:
   Bearer <sha256(domain+secret)>`) *plus* the user token in
   `X-UOA-Access-Token`. The browser must never hold the domain hash
   (`architecture-admin.md` §7). So the portal needs a bearer the API accepts
   in the domain hash's place — the **first-party lane** (§4.5).
2. **User mode gates `:orgId` on the token's `org` claim** (`org-role-guard.ts`
   `assertRequiredOrgRole`: `claims.org.org_id === :orgId`, else `403
   INSUFFICIENT_ORG_ROLE`). A token carries one org context. The portal must
   act on *any* of the person's organisations, and the browser holds no
   refresh token, so the workspace-switch grant is unavailable. The lane
   therefore resolves the org context **live per request** for the route's
   `:orgId` (§4.5) — the shape `resolveSubjectAssertionClaims` already uses.
3. **A first-party config's `domain` must equal the hostname of its
   `config_url`** (`config-verifier.ts` `assertConfigDomainMatchesConfigUrl`).
   A config served from the auth origin therefore has `domain =
   ADMIN_AUTH_DOMAIN` (which defaults to the auth host). The account portal
   **shares the admin domain** and is separated from the admin by *config
   identity and signing secret*, not by domain (§4.4, §8.3). This is the one
   place the design departs from "copy the admin", and it is what makes the
   `system_admin`-free promise structural.

## 3. Information architecture

Routes are under the Vite base `/account/`; the API serves the SPA for
`/account/*` (§4.6). Every screen names the decision it serves.

| Route | Screen | Decision it serves |
| --- | --- | --- |
| `/account/login` | Sign in | Start the OAuth flow; the only public screen. Auto-starts like `Admin/src/pages/LoginPage.tsx`. |
| `/account/auth/callback` | Callback | Exchange the code; never rendered for more than a spinner. |
| `/account` | **Home — where I am** | Which organisation/team do I want to look at; do I have invitations waiting; can I create a workspace. |
| `/account/organisations/new` | Create organisation | Name it (a "General" team is created with it). |
| `/account/organisations/:orgId` | Organisation | Its teams, its people, what I may change here. |
| `/account/organisations/:orgId/teams/new` | Create team | Name/slug/description; I join it as owner. |
| `/account/organisations/:orgId/teams/:teamId` | Team | Its people, how people get in (invitations, links, join policy), what I may change here. |
| `/account/profile` | Profile | Name, avatar, email, how I sign in. |
| `/account/security` | Security | Password, 2FA, sessions. |
| `*` | — | Redirect to `/account`. |

Deliberately **no** `/account/teams` cross-org list, no `/account/members`, no
search page: the home list is the whole directory a person has, grouped the
way UOA's own workspace chooser groups it (organisation header → team rows).
Organisation and team pages are single scrolling pages with sections, not tab
bars — they are short, and a phone reads them top to bottom.

### 3.1 Screen: Home (`/account`)

Data: `GET /account/me` (§9.1) once; cached by TanStack Query, refetched on
focus and after every mutation.

```
┌──────────────────────────────────────────────────────────────┐
│ ◉ UOA                                        (avatar) Ondrej ▾│  ← top bar, 56px
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Where you are                                   + New org  │  ← h1 + primary action (only if
│                                                              │     policy.canCreateOrganisation)
│   ┌─ INVITATIONS ───────────────────────────────────────┐    │
│   │ ┆ Join "Backend" in ACME                             ┆    │  ← dashed InviteCard, one per invite
│   │ ┆ Invited by alice@acme.com · expires in 12 days     ┆    │
│   │ ┆                        [ Decline ]  [  Accept  ]   ┆    │
│   └─────────────────────────────────────────────────────┘    │
│                                                              │
│   ACME                                            Owner ›    │  ← OrgSectionHeader row; whole row links
│   ┌─────────────────────────────────────────────────────┐    │     to /organisations/:orgId
│   │ [AC]  General                          Owner      › │    │  ← team row (WorkspaceCard shape)
│   │ [BE]  Backend                          Admin      › │    │
│   │ [MK]  Marketing                        Member     › │    │
│   │  +    Join "Design" (open to the organisation)      │    │  ← joinable OPEN_TO_ORG team, if any
│   └─────────────────────────────────────────────────────┘    │
│                                                              │
│   NESSIE SANDBOX                                   Member ›  │
│   ┌─────────────────────────────────────────────────────┐    │
│   │ [NS]  Team A                           Member     › │    │
│   └─────────────────────────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- Organisations in `name` order; teams inside in the sidebar order the API
  already defines (`lastLoginAt DESC NULLS LAST, name ASC`).
- The role chip on the org header is the **org** role; on a team row the
  **team** role. Roles are display strings from the server, never interpreted
  by the UI (`roleLabel` rule of the capability plan §3).
- A team row links to the team page; the org header links to the org page.
- `+ New org` appears only when `policy.canCreateOrganisation` is true (it is,
  on the account config — §4.2 — but the UI still reads it).

### 3.2 Screen: Organisation (`/account/organisations/:orgId`)

Data: `GET /account/me` for the org card + capabilities; `GET
/org/organisations/:orgId` (details), `GET …/teams`, `GET …/members`, and —
only when `capabilities['members.manage']` and `memberInvites ===
'admin_approval'` — `GET …/invitations?approval=pending`.

```
┌──────────────────────────────────────────────────────────────┐
│ ‹ Where you are                                              │  ← breadcrumb line
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ [AC]  ACME                                    ⋯      │    │  ← header card; ⋯ = actions menu
│  │       acme · You are Owner · 3 teams · 14 people     │    │     (Rename, Change icon,
│  └──────────────────────────────────────────────────────┘    │      Invite policy, Transfer, Delete)
│                                                              │
│  TEAMS                                          + New team   │  ← only with teams.manage (org)
│  ┌──────────────────────────────────────────────────────┐    │
│  │ [GE]  General · default             Owner         ›  │    │
│  │ [BE]  Backend                       Admin         ›  │    │
│  │ [DS]  Design · open to org          not a member  ›  │    │  ← visible: org member sees all teams
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  PEOPLE                                                      │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ (◯) Alice Example   alice@acme.com   Owner           │    │  ← role select + ⋯ only with the
│  │ (◯) Bob Builder     bob@acme.com     Admin ▾    ⋯    │    │     matching capability (§6)
│  │ (◯) Carol           carol@acme.com   Member ▾   ⋯    │    │
│  │ (◯) Dan (deactivated)               Member      ⋯    │    │  ← muted row; ⋯ → Reactivate
│  │                                        Load more     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  AWAITING YOUR APPROVAL                    (admin_approval)  │  ← conditional section
│  ┌──────────────────────────────────────────────────────┐    │
│  │ eve@x.io → Backend · invited by Carol  [Deny][Approve]│    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  DANGER ZONE                                      (owner)    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Transfer ownership …        Delete organisation …    │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

Dialogs (all `Dialog` from the shared kit, §7.4): **Rename** (name 1–100),
**Change icon** (https URL ≤ 2048 or clear), **Invite policy** (radio:
`allowed` / `admin_approval` / `disabled`, with one sentence each), **Transfer
ownership** (pick a member; confirm by typing the org name; the outgoing owner
becomes `admin` unless the vocabulary lacks it), **Delete** (type the name;
lists what is deleted: every team, membership, invitation).

### 3.3 Screen: Team (`/account/organisations/:orgId/teams/:teamId`)

Data: `GET /org/organisations/:orgId/teams/:teamId?include=invited` (members
+ invited list; the API returns `invited: []` to anyone without
`members.manage`, never a 403), `GET …/invite-links` and `GET
…/access-requests` only with `members.manage`.

```
┌──────────────────────────────────────────────────────────────┐
│ ‹ ACME                                                       │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ [BE]  Backend                                 ⋯      │    │  ← ⋯ = Rename, Description, Slug,
│  │       acme/backend · You are Admin · Invite only     │    │     Join policy, Icon, Upload avatar,
│  └──────────────────────────────────────────────────────┘    │     Delete (never on the default team)
│                                                              │
│  PEOPLE                                       + Add person   │  ← members.manage: opens "Invite by
│  ┌──────────────────────────────────────────────────────┐    │     email" / "Add from organisation"
│  │ (◯) Bob Builder    bob@acme.com     Admin ▾     ⋯    │    │
│  │ (◯) Carol          carol@acme.com   Member ▾    ⋯    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  INVITED                                       (members.manage)
│  ┌──────────────────────────────────────────────────────┐    │
│  │ eve@x.io      Member · sent 2d ago · opened   Resend ⋯│    │  ← ⋯ → Revoke
│  │ frank@x.io    Admin · awaiting approval               │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  INVITE LINKS                                  + New link    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Member · 3/400 used · expires 12 Oct         Revoke  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ACCESS REQUESTS                        (join policy = request)
│  ┌──────────────────────────────────────────────────────┐    │
│  │ (◯) grace@x.io · 3 days ago            [Reject][Approve]   │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

- **Invite by email** dialog: email, optional name, role select from
  `vocabulary.team_roles` minus `owner`. Submits `POST …/invitations` with the
  member-initiated body (`{ email, name?, teamRole? }`). The response is
  always `{ status: "ok" }`; the UI says *"If eve@x.io can be invited, they
  have mail"* — never "already a member" (no enumeration).
- **Add from organisation** dialog: a list of ACTIVE org members not yet in
  the team (from `GET /org/organisations/:orgId/members`), role select;
  `POST …/teams/:teamId/members { user_id, team_role? }`.
- **New link** dialog: role, max uses (≤ 400), expiry days (≤ 30). The token
  is shown **once** with a copy button, rendered as
  `${PUBLIC_BASE_URL}/auth/team-invite-link/<token>` (the existing public
  redemption route).

### 3.4 Screens: Create organisation, Create team

Single-card forms. Create organisation: name → `POST /org/organisations {
name }` → navigate to `/account/organisations/<id>` using the returned record
(`defaultTeam` comes back in the same response; no follow-up read). Create
team: name, slug (optional, shown derived), description → `POST
/org/organisations/:orgId/teams { name, slug?, description?, join_creator:
true }` — `join_creator` is what makes the creator an ACTIVE member of the
team they just made (2026-09-02 fix, `31d0faf`).

### 3.5 Screens: Profile, Security

```
 PROFILE                                 SECURITY
 ┌────────────────────────────┐          ┌──────────────────────────────────┐
 │ (◯) 96px  Change · Remove  │          │ PASSWORD                         │
 │                            │          │ Current password    [••••••••]   │
 │ Display name  [Ondrej    ] │          │ New password        [••••••••]   │
 │ Email          ondrej@…    │ (read-   │ Authenticator code  [ 6 digits ] │ ← only if twoFaEnabled
 │                only, note) │          │                  [ Change password ]
 │ Signs in with  Email, Google│          │ (social-only: "You sign in with   │
 │                            │          │  Google. Set a password →" button │
 │              [ Save ]      │          │  = reset-password email flow)     │
 └────────────────────────────┘          ├──────────────────────────────────┤
                                         │ TWO-FACTOR AUTHENTICATION        │
                                         │ Off · [ Turn on ]  → QR dialog   │
                                         │ On  · [ Turn off ] (needs code)  │
                                         │ On  · required by <org> (no off) │
                                         ├──────────────────────────────────┤
                                         │ SESSIONS                         │
                                         │ [ Sign out everywhere ]          │
                                         │ Signs you out of every product.  │
                                         └──────────────────────────────────┘
```

## 4. Architecture

### 4.1 The app: `/Account`

A third workspace package `@uoa/account` at `/Account`, a copy of the
`/Admin` skeleton (React 19, TypeScript, Vite, React Router, Tailwind,
TanStack Query, react-hook-form + Zod, Vitest; `architecture-admin.md` §3–§9
apply verbatim, with "admin" read as "account"). Vite `base: '/account/'`,
dev port 5175. Directory shape mirrors `Admin/src` (§4 of that doc):

```
/Account/src
  main.tsx, index.css, vite-env.d.ts
  /app          App.tsx (route tree of §3), AppProviders.tsx (QueryClient, Router, ThemeProvider, AccountSessionProvider)
  /layouts      PortalLayout.tsx (TopBar + centred column), TopBar.tsx
  /pages        SignInPage, AuthCallbackPage, HomePage, CreateOrganisationPage, OrganisationPage, CreateTeamPage, TeamPage, ProfilePage, SecurityPage
  /components   /dialogs, /sections, /rows (OrganisationHeaderRow, TeamRow, MemberRow, InviteRow, LinkRow)
  /features     /auth (account-oauth.ts, account-session-storage.ts, account-session.tsx)
                /directory (queries for /account/me), /organisation, /team, /profile, /security
  /services     api-client.ts, account-service.ts, org-service.ts, team-service.ts, profile-service.ts
  /schemas      Zod contracts for every response the app renders
  /config       env.ts (VITE_API_BASE_URL, VITE_ACCOUNT_CONFIG_URL), assets.ts
  /utils
```

Frontend env: `VITE_API_BASE_URL` (optional, same-origin default) and
`VITE_ACCOUNT_CONFIG_URL` (optional override, default
`${origin}/account/config`). No dev auth bypass: unlike the admin, nothing
here is reachable without a real session, and the local flow works against a
local API with a locally signed `ACCOUNT_CONFIG_JWT`.

### 4.2 The account config JWT — **NEW** env `ACCOUNT_CONFIG_JWT`

Served by **NEW** `GET /account/config` (public, `Cache-Control: no-store`,
`text/plain`, the signed RS256 JWT), read by **NEW**
`API/src/services/account-auth-config.service.ts`, a sibling of
`admin-auth-config.service.ts` with these exported names:
`accountConfigUrl()` = `${PUBLIC_BASE_URL}/account/config`,
`accountCallbackUrl()` = `${PUBLIC_BASE_URL}/account/auth/callback`,
`readAccountConfigJwt()`.

The JWT is signed offline with the same config-signing key as
`ADMIN_CONFIG_JWT` (`uoa-auth-config-jwt-private-jwk`, `deploy.md`) and
stored as Secret Manager `uoa-account-config-jwt`. Its payload:

```jsonc
{
  "domain": "authentication.unlikeotherai.com",        // = ADMIN_AUTH_DOMAIN, forced by the config_url hostname rule
  "redirect_urls": ["https://authentication.unlikeotherai.com/account/auth/callback"],
  "enabled_auth_methods": ["email_password", "google"], // open question Q2 for github/apple
  "allow_registration": true,                            // open question Q1
  "language_config": ["en"],
  "2fa_enabled": true,
  "login_flow": { "email_code_enabled": true, "workspace_selection": "off" }, // the portal IS the chooser
  "session": { "remember_me_enabled": false, "access_token_ttl_minutes": 60 }, // no refresh token reaches the browser
  "org_features": {
    "enabled": true,                    // /org/* is 404 otherwise
    "allow_user_create_org": true,      // POST /org/organisations in user mode
    "allow_user_create_team": true,
    "backend_org_management": false,    // the portal never acts as a backend
    "user_needs_team": false,
    "org_roles":  ["owner", "admin", "member"],
    "team_roles": ["owner", "admin", "member"]
    // role_grants absent ⇒ LEGACY_DEFAULT_ROLE_GRANTS
  },
  "ui_theme": { /* §7.1 */ }
}
```

`assertAccountConfigPolicy(config)` fails startup of the account routes (500,
codes `ACCOUNT_CONFIG_DOMAIN_MISMATCH`, `ACCOUNT_CONFIG_CALLBACK_MISSING`,
`ACCOUNT_CONFIG_ORG_FEATURES_REQUIRED`, `ACCOUNT_CONFIG_BACKEND_MODE_FORBIDDEN`,
`ACCOUNT_CONFIG_CHOOSER_MUST_BE_OFF`) unless: `domain === ADMIN_AUTH_DOMAIN`,
`redirect_urls` includes `accountCallbackUrl()`, `org_features.enabled &&
allow_user_create_org`, `backend_org_management === false`,
`login_flow.workspace_selection === 'off'`. It deliberately does **not**
require Google-only or `allow_registration: false` — that is the admin
policy, and the difference is the point.

How it differs from the admin config, in one table:

| | `ADMIN_CONFIG_JWT` | `ACCOUNT_CONFIG_JWT` |
| --- | --- | --- |
| Who may sign in | Google only, registration off, then `SUPERUSER` row required | Anyone with an account; registration per Q1 |
| `redirect_urls` | `/admin/auth/callback` | `/account/auth/callback` |
| `org_features.enabled` | irrelevant | **true** — the whole point |
| Token exchange | `POST /internal/admin/token` (superuser check) | `POST /account/token` (no role check) |
| Token secret / `client_id` | `ADMIN_ACCESS_TOKEN_SECRET` / `admin:<domain>` | **NEW** `ACCOUNT_ACCESS_TOKEN_SECRET` / `account:<domain>` |
| Guard | `requireAdminSuperuser` | **NEW** `requireAccountSession` |

### 4.3 Sign-in flow

Byte-for-byte the admin flow with names changed
(`Account/src/features/auth/account-oauth.ts`):

1. `/account/login` → `beginAccountSignIn(returnTo)`: random 32-byte
   `code_verifier` (base64url), `S256` challenge, persist `{ codeVerifier,
   configUrl, redirectUrl, returnTo, createdAt }` in
   `sessionStorage['uoa-account-pending-login']`, then
   `location.replace(`${apiOrigin}/auth?config_url=${accountConfigUrl}&redirect_url=${origin}/account/auth/callback&code_challenge=…&code_challenge_method=S256`)`.
2. The Auth window renders with the account config's theme; the person signs
   in with email+password / code / Google, completes 2FA if enrolled, and
   because `workspace_selection: 'off'` no chooser appears.
3. Callback `/account/auth/callback?code=…` → `POST
   /account/token?config_url=<accountConfigUrl>` with `{ code, redirect_url,
   code_verifier }` → `{ access_token, expires_in, token_type }` →
   `sessionStorage['uoa-account-session'] = { accessToken, expiresAt }` →
   `GET /account/me` → navigate to `returnTo` (sanitised to a `/`-relative
   path, never `//`).
4. `AccountSessionProvider` mirrors `AdminSessionProvider`: on load, a stored
   token is validated by `GET /account/me`; any `401` clears the session and
   redirects to `/account/login` with `state.from`.

`returnTo` is the only state carried across the redirect; no per-request state
goes on the `redirect_url` (the `/api` config contract forbids it).

### 4.4 Token and session — **NEW** `POST /account/token`, `ACCOUNT_ACCESS_TOKEN_SECRET`, `requireAccountSession`

`POST /account/token` is `/internal/admin/token` with two differences: it
asserts `request.configUrl === accountConfigUrl()` (exact string — the admin
config shares the domain, so a domain check is not enough) and it performs no
role check. Same `tokenExchangeRateLimiter`, same `configVerifier`, same
`exchangeAuthorizationCodeForTokens` inside one BYPASSRLS transaction, same
`{ access_token, expires_in, token_type: 'Bearer' }`, `no-store`. The refresh
token the exchange creates is discarded, exactly as the admin discards it.

`token.service.ts` `resolveAccessTokenContext` today keys the first-party
branch on `domain === ADMIN_AUTH_DOMAIN` and always picks the admin secret.
It changes to key on the **verified config URL** (the function gains a
`configUrl` parameter, available at every call site through
`issueTokenPairForUser(params.configUrl)` and the refresh row's stored
`configUrl`):

| verified `configUrl` | secret | `client_id` claim |
| --- | --- | --- |
| `adminConfigUrl()` | `ADMIN_ACCESS_TOKEN_SECRET` | `admin:<domain>` (unchanged) |
| `accountConfigUrl()` | `ACCOUNT_ACCESS_TOKEN_SECRET` (min 32 chars, required by the account routes only, like the admin secret) | `account:<domain>` |
| any other URL on the admin domain | refuse, `500 FIRST_PARTY_CONFIG_UNKNOWN` | — |

Two guards, two secrets, two `client_id` values:

- **NEW** `API/src/middleware/account-session.ts` `requireAccountSession`:
  `Authorization: Bearer <jwt>` → `verifyAccessToken(token, { sharedSecret:
  ACCOUNT_ACCESS_TOKEN_SECRET, prisma: adminDb })` (so `tokenVersion` is
  checked on every call, like the admin guard) → `claims.domain ===
  ADMIN_AUTH_DOMAIN` → `claims.clientId === 'account:<domain>'` → sets
  `request.accountSession = claims`. Failures are `401` (generic body).
- `requireAdminSuperuser` additionally asserts `claims.clientId ===
  'admin:<domain>'`. Every admin token already carries that value, so this is
  backward compatible; it means that even a `SUPERUSER` who signs in at
  `/account` with a password holds a token `/internal/admin/*` rejects. The
  admin's Google-only policy cannot be bypassed through the account config.

Session lifetime: `session.access_token_ttl_minutes` (max 60, `env.ts`
`ACCESS_TOKEN_TTL` bounds). No refresh token in the browser, so a portal
session ends after ≤ 60 minutes or on any revocation; the app then sends the
person back through `/account/login`, which resumes at the same URL. This is
the admin's accepted model; a longer session is Q9.

### 4.5 The first-party lane on existing routes — **CHANGED** guards, unchanged contracts

The portal calls the existing endpoints with
`Authorization: Bearer <account access token>` and the ordinary query pair
`?domain=<ADMIN_AUTH_DOMAIN>&config_url=<accountConfigUrl>`, and **no**
`X-UOA-Access-Token`. One composed guard replaces
`requireDomainHashAuthForDomainQuery` on the routes listed below:

**NEW** `acceptAccountSessionOrDomainHash` (in `account-session.ts`):

1. Read the bearer. A domain hash is exactly 64 hex characters; a JWT contains
   two dots. If the bearer contains a `.`, it is treated as an account session
   and must pass `requireAccountSession` (else `401`); otherwise the existing
   `verifyDomainHashAuth` runs unchanged. There is no fallback from one to
   the other — a malformed account token is never retried as a hash.
2. On an account session it sets `request.accountSession` and leaves
   `domainAuthClientId` / `domainAuthClientDomainId` **unset**, so
   `acceptDomainBackendCaller` check (1) can never be satisfied — backend mode
   is structurally unreachable from an account session.

`requireOrgRole` (`org-role-guard.ts`) gains a first arm, before the three
existing credential modes:

```
if (request.accountSession) {
  if X-UOA-Access-Token or X-UOA-Subject-Assertion header present → 401 ACCESS_TOKEN_NOT_ALLOWED
  if ?domain= ≠ ADMIN_AUTH_DOMAIN                                  → 403 ACCESS_TOKEN_DOMAIN_MISMATCH
  if request.configUrl ≠ accountConfigUrl()                        → 401 MISSING_CONFIG
  orgId = :orgId (if the route has one)
  org = orgId
    ? await getActiveClientOrgContext({ userId, domain, orgId, groupsEnabled }, { policy: FIRST_PARTY_ACCOUNT, prisma: adminDb, crossProductPrisma: adminDb })
    : undefined
  if (orgId && !org) → 403 INSUFFICIENT_ORG_ROLE     // not an ACTIVE member — same answer as a non-existent id, no existence leak
  assertRequiredOrgRole({ ...claims, org }, orgId, requiredRoles)   // unchanged function
  request.accessTokenClaims = { ...request.accountSession, org, active: undefined }
  return
}
```

`getActiveClientOrgContext` and `buildSidebarWorkspaces` learn a third
server-owned policy value, `{ scope: 'first_party_account' }`
(`product-workspace-policy.service.ts`), which behaves like
`all_active_memberships` (cross-domain, BYPASSRLS read) and is produced only
by the account guard — never by `resolveProductWorkspacePolicy`, which stays
keyed on billing app keys. From here on the request is an ordinary user-mode
request: `setTenantContextFromRequest` derives `app.org_id` from
`claims.org.org_id` (= `:orgId`), and every org table is RLS-scoped by
`app.org_id` (`row-level-security.md` §7), so an organisation created on
another product's domain is readable and writable exactly as the cross-product
user mode already allows. The service layer then loads the actor's live
`OrgMember` / `TeamMember` rows and runs `requireOrgCapability` /
`requireWorkspaceCapability` against `request.config` — the account config —
unchanged. **The server, not the guard, decides every write.**

Routes that take the composed guard (a mechanical swap of the first
`preValidation`/`preHandler` entry; nothing else in those files changes):

| File | Routes |
| --- | --- |
| `routes/org/organisations.ts` | `POST /org/organisations`, `GET/PUT/DELETE /org/organisations/:orgId`, transfer-ownership — **not** `GET /org/organisations` (backend-only; an account session there is `401 ACCESS_TOKEN_NOT_ALLOWED` via the existing header refusal, and the composed guard additionally refuses it because `requireOrgBackendOnly` needs `domainAuthClientDomainId`) |
| `routes/org/organisation-members.ts` | list, add, role, remove, deactivate, reactivate |
| `routes/org/teams.ts`, `team-self-join.ts`, `team-avatar.ts` | list/create/read/update/delete, join, avatar GET/PUT/DELETE |
| `routes/org/team-invitations.ts`, `invitation-approvals.ts`, `team-invite-links.ts`, `access-requests.ts` | all user-mode arms; the backend-only `…/invitations/:inviteId/accept` refuses an account session like it refuses `X-UOA-Access-Token` |
| `routes/avatar/me.ts` | `dualAuth` becomes `[acceptAccountSessionOrDomainHash, requireUserAccessTokenForDomainQuery]`, and `requireUserAccessTokenForDomainQuery` returns early with `request.accessTokenClaims = request.accountSession` when set (domain check kept) |
| `routes/domain/*` user avatar `GET /domain/users/:userId/avatar` | read only — this is the `avatarImageUrl` form every `/org/*` payload carries (`avatars.md` §9), so member tiles render with the bearer the app already holds |
| `routes/twofactor/self-service.ts` | `requireAccessTokenClaims` prefers `request.accountSession` when a preceding **NEW** optional `acceptAccountSession` preHandler set it; the `X-UOA-Access-Token` path is untouched |

Not on the lane: `/org/me` (the portal uses `/account/me`), `/domain/users`,
`/domain/logs`, anything under `/internal/*`, `/auth/token`, `/auth/revoke`.

### 4.6 Serving — `/account/*`

`services/admin-ui.service.ts` is generalised into
`services/static-spa.service.ts` exporting `createSpaReader({ distDirName })`
(index cache, asset read, `readIfExists`, `isStaticAssetPath`);
`admin-ui.service.ts` becomes a two-line re-export for the admin reader so no
caller changes. `routes/admin-ui.ts` becomes `registerSpaRoutes(app, {
prefix: '/admin', reader })` and **NEW** `routes/account-ui.ts` registers the
same for `/account`: `GET /account` → `302 /account/`, `GET /account/assets/*`
immutable one-year cache, `GET /account/*` → `index.html` `no-store` with the
same dotted-deep-link fallback. Static routes registered by
`routes/account/*` (`/account/config`, `/account/token`, `/account/me`, …) win
over the wildcard by Fastify's radix routing; the doc for `/api` says so.

`Dockerfile`: `COPY Account/package.json Account/`, `COPY Account/ Account/`,
`RUN pnpm --filter @uoa/account build`, `COPY --from=build
/app/Account/dist/ Account/dist/`, plus the shared UI package (§7.5).
`pnpm-workspace.yaml` and root `package.json` `workspaces` gain `Account`;
root scripts gain `dev:account`.

Holding page `services/root-page.service.ts` gains the `/account` link
("Manage your account, organisations and teams") and `CLAUDE.md`'s "`GET /`
links to `/admin`, `/llm`, `/api`" sentence is updated in the same change.

## 5. Screens in detail — states

Every screen has exactly these states, rendered by one `QueryState` primitive
(loading skeleton, error card with retry, empty card, content). Words below
are the copy.

| Situation | What the person sees |
| --- | --- |
| No organisations, no invitations | Home: an empty card — *"You're not in any organisation yet."* Below it the **Create your organisation** form inline (the chooser's `CreateFirstWorkspaceForm` pattern): name → create. If `policy.canCreateOrganisation` were false: *"Ask a colleague to invite you, or sign in to the product that manages your team."* |
| Only a pending invitation | Home: the invite card(s) on top, the empty card below; Accept lands them in the org page. |
| Plain member of an org | Org page: header card without `⋯`, Teams section without `+ New team`, People rows without role selects or `⋯`, no approvals, no danger zone. A one-line note under the header: *"You're a member. Owners and admins can change settings here."* |
| Member of the org but not of a team | Team row shows *not a member*; the team page shows People read-only (the API allows any org member to read a team) and, when `joinPolicy === 'OPEN_TO_ORG'`, a **Join team** button; when `REQUEST_TO_JOIN`, the note *"Ask an owner or admin of this team to invite you"* (§1). |
| My membership deactivated | The org disappears from `/account/me` (only ACTIVE rows are listed); nothing to show — the person is not told which org deactivated them (the API is silent by design). |
| Session expired / revoked (`401` anywhere) | Redirect to `/account/login` with a toast *"Your session ended. Sign in again."* |
| `403` on a write | The control was shown because `/account/me` said the capability was held, so a 403 means it changed since: toast *"You no longer have permission to do that. Refreshing."* + refetch `/account/me` and the page; controls disappear. |
| `403 INSUFFICIENT_ORG_ROLE` on navigation to an org/team URL | Page-level card *"You're not a member of this organisation."* with **Back to where you are**. |
| `404` on navigation | Same card, same words (no existence leak). |
| `409 INVITATION_ALREADY_ACCEPTED` on revoke | Toast *"This invitation was already accepted — remove the member instead."* (the one org code that survives the production squash, `public-error-codes.ts`). |
| `400` generic on a write | Inline field error where the form can locate it (e.g. name length), otherwise a card-level *"That didn't work. Check the values and try again."* The client never guesses a reason the server withheld. |
| `400 PASSWORD_POLICY_VIOLATION` | Inline on the new-password field: *"Use at least 8 characters."* (`MIN_PASSWORD_LENGTH`). |
| Password change / sign-out-everywhere succeeded | The app clears its session and shows a full-screen card *"Done. You've been signed out everywhere, including here."* with **Sign in**. |
| 2FA required by policy | Security: *"Two-factor authentication is required for you"* and no **Turn off** — `resolveTwoFaPolicy` in account mode returns the strongest policy across all the person's organisations (§9.6), and `/2fa/disable` refuses independently. |
| 2FA policy `OFF` for the domain | The 2FA section is not rendered (`/2fa/setup` answers 404). |
| Portal not bootstrapped (fresh deployment) | `/account/config` and `/account/token` answer `503`; the sign-in page shows *"The account portal isn't available on this deployment yet."* (§8.3). |

Because `PRODUCTION_PUBLIC_ERROR_CODES` squashes every other code to the
generic body in production, **the app branches on HTTP status and on what
`/account/me` already told it**, never on codes it will not receive. The
allowlist is not widened for the portal.

## 6. Capability-driven UI — the gate table

`GET /account/me` returns, per organisation and per team, a `capabilities`
object computed server-side with the very functions the write routes use
(`configRoleHoldsCapability` at org scope; the org∪team union
`hasWorkspaceCapability` at team scope), plus the three structural
owner-only powers, which are not capabilities at all (`DELETE
/org/organisations/:orgId`, transfer-ownership and `PUT
…/members/:userId` all require `Organisation.ownerId === actor`).

| Control | Visible + enabled when | Shown to a person who lacks it |
| --- | --- | --- |
| Home → **+ New org**, empty-state create form | `policy.canCreateOrganisation` | Nothing (the empty state explains) |
| Org header **⋯ → Rename / Change icon / Invite policy** | `org.capabilities['organisation.manage']` | No menu; the "You're a member" note |
| Org → **+ New team** | `org.capabilities['teams.manage']` | Nothing |
| Org → People → role select | `org.isOwner` | Static role label |
| Org → People → ⋯ **Remove / Deactivate / Reactivate** | `org.capabilities['members.manage']`; Remove on an owner additionally `org.isOwner` (the API refuses otherwise) | No `⋯` |
| Org → **Awaiting your approval** section | `org.capabilities['members.manage'] && org.memberInvites === 'admin_approval'` | Section absent |
| Org → **Transfer ownership**, **Delete organisation** | `org.isOwner` | Danger zone absent |
| Team header **⋯ → Rename / Slug / Description / Join policy / Icon / Upload avatar** | `team.capabilities['teams.manage']` | No menu |
| Team header **⋯ → Delete team** | `team.capabilities['teams.manage'] && !team.isDefault` | Item absent (default team cannot be deleted; API refuses with the generic 400) |
| Team → **+ Add person** (invite by email / add from org), role selects, ⋯ Remove | `team.capabilities['members.manage']` | Static labels; plus, when `org.memberInvites === 'allowed'` and the person is a team member, a single **Invite by email** button — any active member may invite under that policy (`POST …/invitations` member-initiated arm) |
| Team → **Invited** section (PII) | `team.capabilities['members.manage']` | Section absent (the API returns `invited: []` regardless) |
| Team → **Invite links** section | `team.capabilities['members.manage'] && team.joinPolicy !== 'HIDDEN'` | Section absent |
| Team → **Access requests** section | `team.capabilities['members.manage'] && team.joinPolicy === 'REQUEST_TO_JOIN'` | Section absent |
| Team → **Join team** | not a member and `team.joinPolicy === 'OPEN_TO_ORG'` | The "ask an owner or admin" note |
| Home invite card **Accept / Decline** | the invite is addressed to my email (the server checks; the list only contains mine) | — |
| Security → **Turn off 2FA** | `me.twoFaEnabled && policy.twoFa !== 'REQUIRED'` | *"required for you"* note |
| Security → **Change password** form | `user.hasPassword` | **Set a password** (reset email) |

Rules the implementer must keep: (1) hiding is a courtesy, the server refuses
too — every write path above already carries its gate and the lane does not
weaken it; (2) the role label is display only; the UI never compares it —
`capabilities` and `isOwner` are the only booleans it branches on; (3) role
selects are populated from `vocabulary.org_roles` / `vocabulary.team_roles`
returned by `/account/me`, `owner` removed (owner is transferred, never
assigned).

## 7. Visual design

### 7.1 Language: the Auth window's, fed by the account config

The portal must read as the same product as the sign-in window the person just
came through and as UOA's own workspace chooser (organisation headers, team
rows). Both are drawn from **one** source — the account config's `ui_theme` —
through the Auth window's existing token system: `--uoa-color-{bg, surface,
text, muted, primary, primary-text, border, danger, danger-text}` and
`--uoa-radius-{card, button, input}` (`Auth/src/theme/theme-defaults.ts`).
The app fetches `GET /account/config`, base64url-decodes the JWT payload
(no verification needed for colours; it is same-origin over HTTPS and the
server verified it), and passes `ui_theme` to the shared `ThemeProvider`,
which writes the variables on `.uoa-theme` exactly as the Auth window does.
There is no second design system and no colour literal in the app.

The values in `ACCOUNT_CONFIG_JWT.ui_theme` — warm off-white ground, white
cards, ink primary, generous radii:

```jsonc
"ui_theme": {
  "colors": { "bg": "#F5F1EA", "surface": "#FFFFFF", "text": "#1C1917", "muted": "#78716C",
              "primary": "#1C1917", "primary_text": "#FFFFFF", "border": "#E7E0D6",
              "danger": "#B91C1C", "danger_text": "#FFFFFF" },
  "radii": { "card": "16px", "button": "10px", "input": "10px" },
  "density": "comfortable",
  "typography": { "font_family": "system-ui, -apple-system, sans-serif", "base_text_size": "md" },
  "button": { "style": "solid" },
  "card": { "style": "shadow" },
  "logo": { "url": "<same value as ADMIN_CONFIG_JWT uses>", "alt": "UnlikeOtherAI" }
}
```

Changing the look later is a config re-sign, not a deploy. Q10 asks the owner
to confirm the palette against the phone screenshot.

### 7.2 Shell and layout

- **Shell:** a 56px top bar (logo/wordmark left, the person's avatar tile +
  name as a menu on the right: Profile, Security, Sign out) over a **single
  centred column**, `max-w-2xl` (672px) with `px-4 sm:px-6`, `py-8`. No
  sidebar: the IA is two levels deep and the chooser the owner screenshotted
  is a column. The top bar is `bg-[var(--uoa-color-surface)]` with a
  `border-b border-[var(--uoa-color-border)]`.
- **Phone (< 640px):** identical column at full width, 16px gutters, header
  actions collapse into the `⋯` menu, dialogs become bottom sheets
  (`Dialog` handles it), rows keep 56px minimum touch height.
- **Breadcrumb line** under the top bar on org/team pages: `‹ Where you are`
  / `‹ ACME`, `text-sm text-[var(--uoa-color-muted)]`.
- **Sections:** `OrgSectionHeader` shape — `text-xs font-semibold uppercase
  tracking-wider text-[var(--uoa-color-muted)]`, with an optional right-aligned
  action (`Button variant="secondary" size="sm"`). Section gap 20px
  (`gap-5`), block gap 32px (`gap-8`), row gap 12px (`gap-3`).
- **Cards:** `Card` from the kit (`rounded-[var(--uoa-radius-card)]`,
  `border-[var(--uoa-color-border)]`, `bg-[var(--uoa-color-surface)]`,
  density padding `p-5`). Rows inside a card are separated by
  `divide-y divide-[var(--uoa-color-border)]`; a card never contains a card.

### 7.3 The row

One `EntityRow` shape for organisations, teams, people, invites and links
(`WorkspaceCard` generalised): `flex items-center gap-3 px-3 py-3 min-h-14`;
a **40px tile** (`h-10 w-10 rounded-[var(--uoa-radius-button)]`) that is the
image or the deterministic initials-on-colour badge from
`workspace-icon.ts` (`workspaceAvatarColor(id)`, `workspaceInitials(name)`);
a `min-w-0 flex-1` text block — primary `text-sm font-medium text-[…-text]
truncate`, secondary `text-xs text-[…-muted] truncate`; a trailing slot —
role chip (`text-xs rounded-full border px-2 py-0.5`), a role `<select>`, a
`⋯` icon button, or `›`. The whole row is a link when it navigates and a
`<div>` when it does not; never both.

Organisation header card: 56px tile, name `text-xl font-semibold`, secondary
line `slug · You are <role> · N teams · N people`, `⋯` top-right.

Type scale (from `theme-utils` `classNames`): page title `text-2xl
font-semibold tracking-tight`, card title `text-xl font-semibold`, body
`text-sm`, meta `text-xs`. People avatars are round (`rounded-full`);
organisation/team tiles keep the button radius — the same distinction the
Admin's `Avatar shape` draws.

### 7.4 Components, and where each comes from

| Component | Source |
| --- | --- |
| `ThemeProvider`, `useTheme`, `theme-utils`, `theme-defaults`, `theme-types` | moved from `Auth/src/theme` + `Auth/src/hooks/use-theme.ts` into the shared package |
| `Button` (primary/secondary), `Card`, `Input`, `PasswordInput`, `CodeInput`, `Switch`, `Logo` | moved from `Auth/src/components/ui` |
| `workspaceAvatarColor`, `workspaceInitials` | moved from `Auth/src/utils/workspace-icon.ts` |
| `OrgSectionHeader`, `InviteCard` (visual only; actions injected) | moved from `Auth/src/components/workspace` |
| `EntityRow`, `Dialog` (+ bottom-sheet on phone), `ConfirmDialog` (typed-name variant), `Menu` (`⋯`), `RoleSelect`, `Toast`, `QueryState`, `TopBar` | **new in `/Account`**; `Dialog`/`ConfirmDialog`/`Menu` are written once and are candidates to move into the shared package when the Auth window needs them |
| `AvatarImage` (authed blob → object URL, initials until `onLoad`) | port of `Admin/src/components/ui/Avatar.tsx` + `Admin/src/utils/use-object-url.ts`, restyled with tokens |

The Admin's Tailwind-literal primitives (`bg-indigo-600`, `bg-slate-950`)
are **not** reused — they are the operator look, deliberately different.

### 7.5 The shared package — **NEW** `packages/uoa-ui` (`@uoa/ui`)

Extraction, not invention: the files above move (git `mv`) into
`packages/uoa-ui/src`, the Auth app's imports are re-pointed, and both apps
depend on `@uoa/ui` via the workspace. Constraints: SSR-safe (the Auth build
has `entry-server.tsx`), no `window` at module scope, Tailwind classes only,
`content` globs in both apps' `tailwind.config.cjs` include
`../packages/uoa-ui/src/**/*.{ts,tsx}`. `Dockerfile` copies the package like
`billing-statement-protocol`. This is Phase 1's first task because everything
visual depends on it; it is also the only Auth-touching change in the plan
and must leave the Auth window byte-identical (its Vitest suite is the check).

## 8. Security

### 8.1 Why user mode, and why not a BFF

The portal acts *as the person*, never as a tenant: every write is gated by
that person's live membership and capability, audited with `actor_user_id`,
and cannot reach backend mode (§4.5). A server-side BFF holding the domain
hash would be a second copy of forty routes and would make every call a
backend-mode call with a spoofable "on behalf of" — the exact promotion
`resolveOrgAccessTokenHeader`'s comment warns about.

### 8.2 What a stolen account access token can and cannot do

Can, for ≤ 60 minutes or until the person's `tokenVersion` moves: everything
the person can do in the portal — rename their organisations, invite and
remove people, change 2FA (with a code), change the password (**only with the
current password**, §9.4), upload an avatar. Cannot: reach `/internal/admin/*`
(wrong secret, wrong `client_id`), obtain a refresh token (none is issued to
the browser), act on an organisation the person is not an ACTIVE member of,
act as a domain backend, or read anything under another product's
domain-hash. The person ends it with **Sign out everywhere** (`tokenVersion`
bump — the stolen token dies on its next request, because
`requireAccountSession` verifies the epoch against the database on every
call), or by changing the password, which does the same.

### 8.3 The shared first-party domain, and the three things that follow

The account config's `domain` is `ADMIN_AUTH_DOMAIN` (fact 3, §2). Three
consequences, each handled:

1. **Superuser bootstrap.** `ensureDomainRoleForUser` makes the first user on
   any domain its `SUPERUSER`, and `isAdminSuperuserBootstrap` bypasses the
   registration policy on the admin domain while no `SUPERUSER` exists. On a
   fresh deployment, whoever reaches `/account` first would become the
   platform superuser. Closed structurally: **`GET /account/config` and `POST
   /account/token` answer `503` (generic body, internal code
   `ACCOUNT_PORTAL_NOT_READY`) while `domain_roles` holds no `SUPERUSER` row
   for `ADMIN_AUTH_DOMAIN`** (skipped DB-less). Production already has one,
   so the guard is inert there and decisive everywhere else.
2. **Admin tokens vs account tokens.** Separate secrets and the `client_id`
   check on both guards (§4.4). A superuser's account token is not an admin
   token; an admin token is not an account token.
3. **Per-domain settings are shared:** `ClientDomain.twoFaPolicy` (the
   domain's 2FA policy applies to both sign-ins), and the domain's login
   allowlist (`allowedEmails` / `allowedEmailDomains`, edited on the Admin
   domain page → Access). **Pre-flight (Q3):** the auth-host `ClientDomain`
   allowlist must be empty, or the portal admits only those addresses.

### 8.4 No enumeration, generic errors

Unchanged rules, and the new endpoints obey them: `/account/password` answers
the same generic `400` for wrong current password, missing/invalid TOTP,
and a social-only account (the argon2 dummy-hash path keeps timing flat);
`PASSWORD_POLICY_VIOLATION` is the only code that survives, and it is already
public. Invitation accept/decline answer a generic `400` for unknown, foreign,
expired, revoked, or not-mine invitations alike. `/account/me` never lists
another person's invitations or memberships. The member-initiated invite
response stays `{ status: "ok" }`.

### 8.5 Rate limits (in-process `createRateLimiter`, composed with the global ceiling like `rate-limit-keys.ts`)

| Route | Keys |
| --- | --- |
| `POST /account/token` | existing `tokenExchangeRateLimiter` |
| `GET /account/config` | existing `configFetchRateLimiter` pattern, per IP |
| `POST /account/password` | 5 / 15 min per user id, 20 / 15 min per IP, + global |
| `POST /account/sessions/revoke-all` | 10 / hour per user id |
| `PUT /account/profile` | 30 / hour per user id |
| `POST /account/me/invitations/:id/{accept,decline}` | 30 / hour per user id |
| everything on the lane | the route's own existing limiter, unchanged |

### 8.6 CSP and asset serving

The account SPA is served by the API with the same `@fastify/helmet` policy
the admin gets (`app.ts`), same immutable asset caching and `no-store` shell
(§4.6). The app makes only same-origin requests (`api-client.ts` refuses a
cross-origin `VITE_API_BASE_URL`, as the admin's does), loads no third-party
script, and renders avatar bytes as object URLs from authenticated fetches —
`<img src="/api/…">` cannot carry the bearer. A `font_import_url` in
`ui_theme` is honoured only from the hosts `theme-utils.ts` already
allowlists.

## 9. API delta

Every item below updates `API/src/routes/root/schema.ts` (via **NEW**
`schema.account.ts`), `schema.org-contract.ts` (the shared `/org/*`
calling-mode note gains **FIRST-PARTY ACCOUNT MODE**), `schema.avatars.ts`
(auth note), and **NEW** `llm-account.ts` appended in `llm.ts` — `/api` and
`/llm` never fall out of sync (`CLAUDE.md`). Error bodies are the generic
`{ error: "Request failed" }` unless a code is listed as public.

### 9.1 **NEW** `GET /account/me`

- Auth: `requireAccountSession`. No query.
- Response `200`:

```jsonc
{
  "ok": true,
  "user": { "id": "…", "email": "ondrej@…", "name": "Ondrej" | null,
            "avatarImageUrl": "<PUBLIC_BASE_URL>/avatar/me?domain=<d>",
            "hasPassword": true, "twoFaEnabled": false,
            "authMethods": ["email", "google"],          // AuthIdentity.provider rows
            "createdAt": "…" },
  "session": { "expiresAt": "…" },
  "vocabulary": { "org_roles": ["owner","admin","member"], "team_roles": ["owner","admin","member"] },
  "policy": { "twoFa": "OFF"|"OPTIONAL"|"REQUIRED", "canCreateOrganisation": true },
  "organisations": [ {
      "orgId": "…", "name": "ACME", "slug": "acme", "iconUrl": null, "originDomain": "app.nessie.works",
      "role": "owner", "isOwner": true, "memberInvites": "allowed",
      "capabilities": { "organisation.manage": true, "teams.manage": true, "members.manage": true },
      "teams": [ { "teamId": "…", "name": "General", "slug": "general", "isDefault": true,
                   "joinPolicy": "INVITE_ONLY", "avatarImageUrl": "<PUBLIC_BASE_URL>/teams/<id>/avatar",
                   "role": "owner", "lastLoginAt": "…"|null,
                   "capabilities": { "teams.manage": true, "members.manage": true } } ],
      "joinableTeams": [ { "teamId": "…", "name": "Design", "slug": "design", "avatarImageUrl": "…" } ]  // OPEN_TO_ORG, not a member
  } ],
  "pending_invites": [ { "inviteId": "…", "orgId": "…", "orgName": "ACME", "teamId": "…", "teamName": "Backend",
                         "invitedBy": "alice@acme.com" | null, "expiresAt": "…" | null } ]
}
```

- Service: **NEW** `services/account-directory.service.ts`. Memberships via
  `buildSidebarWorkspaces` under `{ scope: 'first_party_account' }` (adminDb);
  org rows from ACTIVE `OrgMember` joined to `Organisation` (`ownerId`,
  `memberInvites`, `iconUrl`, `domain`); pending invites via
  `buildSidebarPendingInvites` widened with a `domain: null` (all domains)
  arm that keeps `pendingInviteStatusWhere`; capabilities from
  `configRoleHoldsCapability(accountConfig, 'org', role, cap)` and
  `hasWorkspaceCapability(accountConfig, { orgRole, teamRole }, cap)`; policy
  from `resolveTwoFaPolicy` in all-organisations mode (§9.6). The account
  config is read through `readAccountConfigJwt()` + `validateConfigFields`
  (not fetched over HTTP; this route has no `config_url`).
- Errors: `401`; `503` when not bootstrapped (§8.3).

### 9.2 **NEW** `GET /account/config` — §4.2. `POST /account/token` — §4.4

`POST /account/token`: query `config_url` (required, must equal
`accountConfigUrl()`); body `{ code, redirect_url, code_verifier? }`;
`200 { access_token, expires_in, token_type: "Bearer" }`; `400 MISSING_CONFIG`,
`403 ACCOUNT_CONFIG_MISMATCH` (any other config URL), `401` on a bad code,
`503` not bootstrapped. Rate: `tokenExchangeRateLimiter`.

### 9.3 **NEW** `PUT /account/profile`

- Auth: `requireAccountSession`. Body (strict): `{ "name": string | null }`
  — trimmed, 1–100 chars, control characters rejected; `null` clears.
- `200 { ok: true, user: <§9.1 user> }`. Errors: `400` (generic), `401`.
- Service: `services/account-profile.service.ts` `updateDisplayName`, one
  `user.update`. Audit: structured server log; no org audit row (no org).

### 9.4 **NEW** `POST /account/password` — signed-in password change

- Auth: `requireAccountSession` + limiter (§8.5). Body (strict):
  `{ "current_password": string(1..1024), "new_password": string(1..1024), "code"?: string(6) }`.
- Service **NEW** `services/account-password.service.ts`
  `changePasswordForUser({ userId, credentialEpoch, currentPassword, newPassword, code })`,
  one `runInTransaction(adminDb)`:
  1. `lockAndAssertGlobalAuthenticationEpoch({ userId, credentialEpoch })` —
     the user-global lock every revocation path takes, and a stale token
     fails here with the generic `401`.
  2. Load `{ passwordHash, twoFaEnabled, twoFaSecret, twoFaLastAcceptedCounter }`.
     `verifyPassword(currentPassword, passwordHash)` (dummy hash when
     `null` → `false`, timing flat). `false` → `400` generic.
  3. If `twoFaEnabled`: `code` is required and verified with
     `verifyTwoFactorForLogin` semantics (counter replay protection, the
     counter is persisted). Missing or wrong → the same `400`.
  4. `assertPasswordValid(newPassword)` (`400 PASSWORD_POLICY_VIOLATION`,
     public), refuse `newPassword === currentPassword` with the generic `400`,
     `hashPassword`, `user.update({ passwordHash })`.
  5. In the same transaction, the body of `revokeAllRefreshTokensForUser`:
     revoke every refresh family for the user (all domains, all products)
     and `bumpUserTokenVersion` — every access token, including the caller's
     own account token, is invalid from this moment. This is the same
     consequence `resetPasswordWithToken` already applies; a credential
     change ends every session that was minted under the old one.
- `200 { ok: true, signed_out: true }`. The app then clears its session (§5).
- **2FA-enrolled users:** enrolment is untouched — password and TOTP are
  independent factors; the code requirement in step 3 is what stops a stolen
  session plus a shoulder-surfed password from rotating the credential.
- **Social-only accounts** (`passwordHash === null`): step 2 fails
  generically; the UI never shows this form to them (`user.hasPassword`) and
  offers **Set a password** = `POST
  /auth/reset-password/request?config_url=<accountConfigUrl>` `{ email }`
  (no enumeration; the mail links into the Auth window bound to the account
  config, `SetPasswordPage`, which then revokes and re-signs-in the same way).
- Not sent in v1: a "your password was changed" email (Q6). Audit: structured
  server log with `userId` only.

### 9.5 **NEW** `POST /account/sessions/revoke-all`

- Auth: `requireAccountSession` + limiter. No body.
- Service: `revokeAllRefreshTokensForUser(userId)` as-is.
- `200 { ok: true, signed_out: true }`. The caller's token is dead too.
  `/auth/revoke` is not usable here (it needs a refresh token the browser
  never holds), which is why this endpoint exists.

### 9.6 **CHANGED** `resolveTwoFaPolicy` — all-organisations mode

`twofactor-policy.service.ts` gains an `{ allActiveOrganisations: true }`
option: `strongest(domainPolicy, every ACTIVE OrgMember's org.twoFaPolicy
across domains)`. Only the account arms use it (`/2fa/setup`, `/2fa/disable`
when `request.accountSession` is set, and `/account/me`). Product calls are
unchanged. Without this a person whose Nessie organisation requires 2FA could
switch it off in the portal and be re-forced at the next product login —
not a bypass, but a lie in the portal's own UI.

### 9.7 **NEW** `POST /account/me/invitations/:inviteId/accept`, `…/decline`

- Auth: `requireAccountSession` + limiter. No body. `inviteId` path param.
- Service: one `runInTransaction(adminDb)` calling
  `acceptTeamInviteWithinTransaction({ prisma: tx, teamInviteId, userId,
  config: accountConfig, now })` / `declineTeamInviteForUser(...)` — the
  functions `POST /auth/select-team` already calls; they verify the invite is
  addressed to the caller's email and is actionable, create the ACTIVE org +
  team memberships, and refuse everything else with the generic `400`.
- `200 { ok: true, orgId, teamId }` / `200 { ok: true }`. `400`, `401`.
- Acceptance is membership only; a target organisation's `REQUIRED` 2FA is
  enforced at the product login, exactly as after the backend-mode
  `…/invitations/:inviteId/accept`.

### 9.8 **CHANGED** guards, unchanged contracts — the lane (§4.5)

Listed in the table in §4.5. `/api` notes per affected slice: "FIRST-PARTY
ACCOUNT MODE: `Authorization: Bearer <account access token>` (a JWT, never a
64-hex domain hash) with `?domain=<ADMIN_AUTH_DOMAIN>&config_url=<PUBLIC_BASE_URL>/account/config`
and no `X-UOA-Access-Token`; the `:orgId` is authorised by live ACTIVE
membership rather than the token's org claim; backend mode is unreachable;
role vocabulary and grants are the account config's."

### 9.9 **CHANGED** `token.service.ts` `resolveAccessTokenContext` — §4.4. **CHANGED** `requireAdminSuperuser` — `client_id` check. **NEW** env `ACCOUNT_CONFIG_JWT`, `ACCOUNT_ACCESS_TOKEN_SECRET` (`env.ts`, `Docs/techstack.md` env list, `Docs/deploy.md` table + Secret Manager names `uoa-account-config-jwt`, `uoa-account-access-token-secret`).

### 9.10 Endpoints deliberately **not** added

- No "add org member by id" surface, no user search (§1).
- No `/account/me/organisations/:orgId/...` mirrors: the portal uses `/org/*`.
- No new public error codes.
- No refresh endpoint (Q9).

## 10. Phase plan

Each phase ships and is verified on its own; nothing in a later phase is
required for an earlier one to be correct.

### Phase 1 — sign in at `/account` and see where you are (read-only)

1. `packages/uoa-ui` extraction (§7.5); Auth window byte-identical
   (`pnpm --filter @uoa/auth test`, a Playwright screenshot of `/auth` before
   and after).
2. API: `ACCOUNT_CONFIG_JWT` + `account-auth-config.service.ts`;
   `GET /account/config`; `POST /account/token`;
   `resolveAccessTokenContext` by config URL + `ACCOUNT_ACCESS_TOKEN_SECRET`;
   `requireAccountSession`; `requireAdminSuperuser` `client_id` check; the
   bootstrap `503`; `GET /account/me`; `first_party_account` policy value;
   `static-spa.service.ts` + `/account/*` serving; holding-page link;
   `/api` + `/llm`; env docs.
3. `/Account` app: shell, sign-in, callback, session provider, Home with
   organisations/teams/invites **read-only** (invite cards render without
   buttons this phase), Profile page read-only, `AvatarImage`.
4. Build: workspace + `Dockerfile` + root scripts.

Verify: unit tests for the guard (an admin token is refused by
`requireAccountSession` and vice versa; a 64-hex bearer never reaches the
account path; an account bearer never sets `domainAuthClientDomainId`),
`/account/me` capabilities pinned against `LEGACY_DEFAULT_ROLE_GRANTS` for
owner/admin/member × org/team; Playwright headless: a seeded person with two
organisations signs in at `http://127.0.0.1:<api>/account`, sees both, opens
nothing; `curl /api | jq` shows every new endpoint.

### Phase 2 — manage organisations and teams

1. The lane on `/org/*` and team avatar (§4.5 table), `getActiveClientOrgContext`
   first-party arm, `/api` slice notes.
2. Invitation accept/decline (§9.7); Home invite cards become actionable.
3. Org page (all sections and dialogs of §3.2), Team page (§3.3), Create
   organisation, Create team, join `OPEN_TO_ORG`.

Verify: route tests per capability (owner/admin/member on org and team, each
write, expected status); a Playwright run that creates an org, renames it,
creates a team, invites an address, revokes the invite, transfers ownership
and deletes — as owner; then the same as a member, asserting the controls are
absent and a forced `PUT` returns `403`.

### Phase 3 — profile and security

1. `PUT /account/profile`; `/avatar/me` and `/domain/users/:id/avatar` on the
   lane; `POST /account/password`; `POST /account/sessions/revoke-all`;
   `/2fa/*` account arm + all-organisations policy.
2. Profile page editable; Security page complete (§3.5).

Verify: password change kills a second tab's session (tokenVersion) and a
seeded product refresh token; wrong current password / missing TOTP answer the
same generic `400` with flat timing; a `REQUIRED`-org user sees no **Turn
off**; social-only account sees **Set a password** and the reset mail is sent.

### Phase 4 — vocabulary fidelity and joining

1. Resolve the **origin domain's** role vocabulary and grant table for an
   organisation created by a product (Q4): persist the last verified config
   payload per `ClientDomain` at config verification (a `ClientDomainConfigSnapshot`
   row keyed by domain, replaced on every successful fetch), and let the
   account arm of `requireOrgRole` substitute that domain's `org_features`
   into `request.config` for the request. Until then the account config's
   default vocabulary governs the portal (§9.8).
2. `REQUEST_TO_JOIN`: a user-mode "request access" endpoint reusing
   `access-request.service.auth.ts`, and the team page button.
3. `language_config` beyond `en` through the shared `I18nProvider`.

### Phase 5 (optional) — a longer portal session

Only if Q9 says the ≤ 60-minute session is not acceptable: `POST
/account/token` sets the refresh token in an `HttpOnly; Secure;
SameSite=Strict; Path=/account/token` cookie and accepts
`grant_type=refresh_token` from that cookie, rotating through the existing
family machinery; `POST /account/logout` revokes the family. Nothing else
changes — the browser still never sees the refresh token.

## 11. Open questions for the owner

Resolved from the repo where possible; each carries the recommended answer
the phases assume.

1. **Registration on `/account`.** Recommended `allow_registration: true`: a
   person can create their account and then their first organisation here,
   which is the "alternative option" the owner described. If the portal is
   for existing accounts only, set `false` — the flow is otherwise identical.
2. **Auth methods.** Recommended `["email_password", "google"]`. Add
   `github`/`apple`/`microsoft` only for providers whose credentials the auth
   service already holds.
3. **Pre-flight on the auth-host `ClientDomain`:** its login allowlist must be
   empty and its `twoFaPolicy` is shared with the admin sign-in (§8.3). Confirm
   before Phase 1 goes live.
4. **Role vocabulary for product-created organisations.** Phases 1–3 apply
   the account config's default `owner/admin/member` + legacy grants to every
   organisation, the same rule cross-product user mode applies today (the
   calling domain's config governs). A domain that has configured extra
   roles or a custom grant table gets exact fidelity only after Phase 4.
   Acceptable interim?
5. **Visibility of organisations created in the portal.** They are created
   with `Organisation.domain = <auth host>`, so a product sees them only under
   the `all_active_memberships` policy (a product with an active
   `customer_lifecycle` app key — Nessie and its siblings); a legacy
   same-domain product does not. Confirm this matches the estate.
6. **Password-changed notification email.** Not in v1; needs a
   `DomainEmailConfig` for the auth host domain.
7. **Billing in the portal.** Out of scope (§1); the path, if wanted later,
   is a first-party billing service + app key and a protocol client.
8. **Account deletion.** Out of scope; no endpoint exists anywhere.
9. **Session length.** ≤ 60 minutes with silent re-login through
   `/account/login`, as the admin does. Phase 5 if that is too short.
10. **Palette.** §7.1 proposes warm off-white/ink; confirm against the phone
    screenshot, or supply the product theme it came from — it is one config
    re-sign either way.

## 12. Docs to update in the same change (per phase)

- `CLAUDE.md`: repository structure (`/Account`), the `GET /` sentence, env
  list pointer. `AGENTS.md` if it lists apps.
- `Docs/techstack.md`: `/Account` section (mirror of the Admin one), env vars.
- `Docs/deploy.md`: the two secrets, the account config signing/validation
  step beside the admin one, the bootstrap `503`.
- `Docs/Auth/architecture-api.md`: tree entries for every new file in §4–§9.
- `Docs/Auth/architecture-auth.md`: the theme/ui files now imported from
  `@uoa/ui`.
- **NEW** `Docs/Account/architecture-account.md` (Phase 1): the `/Account`
  counterpart of `architecture-admin.md` — route map (§3), auth boundary
  (§4.3–§4.4), data rules (§5–§6), visual rules (§7). This design doc moves to
  `Docs/done/` when Phase 3 lands.
- `Docs/Requirements/roles-and-acl.md`: the "UOA account page" sentence
  (Microsoft SSO section) now has a location: `/account`.
- `/llm` and `/api` as stated in §9.
