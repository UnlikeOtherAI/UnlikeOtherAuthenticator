# Roles & ACL — Requirements

## Two distinct role systems

There are two completely separate concepts that must not be conflated.

### 1. UOA system roles (internal)

These control who can administer the UOA backend itself — the org and team structure, billing, membership. There are exactly two UOA system roles:

| Role | Scope | Rules |
|---|---|---|
| `owner` | Org or Team | Created with the org/team. Cannot be removed. Can transfer ownership to any other user. Implicitly has all admin capabilities. |
| `admin` | Org or Team | Full power: delete teams, manage billing, manage members, manage domains. Multiple admins allowed. Any user can be granted or revoked admin. |

Users who are neither `owner` nor `admin` have no named UOA system role — they are plain members whose significance is defined entirely by their custom role.

`system_admin` is a separate global role for UOA's own admin panel operators and is not visible to org/team users.

### 2. Consumer-defined roles (external, custom)

These are roles that a developer or org defines for their own product. UOA stores only the **label** — a string reference. UOA has no opinion on what the role permits. The consuming application owns all gating logic.

- Any number of custom roles per team or organisation — no cap
- Each role set has exactly one **default role** — marked with a tick in the admin UI. Any user added without a specified role, or auto-enrolled via domain rule, receives the default role automatically
- Custom roles can share names with UOA system roles (different namespaces, no conflict)
- A user's UOA role and their custom role are completely orthogonal

UOA's only responsibilities for custom roles:
- Store the role definitions per team/org, including which is the default
- Validate that a role assigned to a user exists in the team/org's defined list
- Return the role label(s) in the access token and via API
- Enforce nothing beyond that

---

## Hierarchy model

```
Organisation
  ├── has many Domains     (multiple — one org can serve hundreds of services)
  ├── has UOA role assignments (owner, admin) per member
  ├── has custom role definitions (with one marked default)
  └── has many Teams
        ├── references one or more Domains from the org's domain pool
        ├── has UOA role assignments (owner, admin) per member
        ├── has custom role definitions (with one marked default, can differ from org-level)
        └── has Members with assigned custom roles
```

### Auto-organisation rule

Teams are the primary registration unit. Not every setup needs a full enterprise org structure.

**Rule:** When a team is created without specifying an organisation, UOA automatically creates an organisation with the same name and slug and places the team under it. That org starts in single-team mode.

- Single-team org = the default, lightweight path (most small integrations)
- Multi-team org = enterprise path, unlocked simply by adding a second team
- Teams are always under an org — the org may just be implicit and auto-created

### Domain assignment

- Domains are registered at **organisation level**
- An org can have any number of domains (`api.acme.com`, `app.acme.com`, `admin.acme.com`, etc.)
- A domain belongs to exactly one organisation
- Teams reference domains from their org's pool — the team is what gets registered against a domain
- Inbound auth request flow: domain → org → team registered for that domain → user's membership and roles for that team

---

## Custom role definitions

Each team (and optionally org) defines its own role names. One role is marked as the default.

```json
{
  "teamId": "team_abc",
  "customRoles": [
    { "name": "editor",  "default": false },
    { "name": "viewer",  "default": true  },
    { "name": "staff",   "default": false },
    { "name": "manager", "default": false }
  ]
}
```

- Exactly one role per team must be marked default at all times
- If the default role is deleted, the admin must designate a new default before the deletion is allowed
- No limit on number of roles
- Role names validated only for being non-empty strings — format is up to the defining org

What a role *permits* inside the consuming application is entirely that application's concern.

---

## Token output

```json
{
  "sub": "user_123",
  "email": "alice@acme.com",
  "orgs": [
    {
      "id": "org_abc",
      "slug": "acme",
      "uoaRole": "admin",
      "customRoles": ["manager"],
      "teams": [
        {
          "id": "team_xyz",
          "name": "Backend",
          "domain": "api.acme.com",
          "uoaRole": "admin",
          "uoaRoleInherited": true,
          "customRoles": ["editor"]
        }
      ]
    }
  ]
}
```

- `uoaRole` — `owner`, `admin`, or omitted if neither
- `uoaRoleInherited` — true if derived from org-level role rather than explicit team assignment
- `customRoles` — array of the consuming app's role labels. See decision in the role model section below.

---

## UOA system role inheritance

Inheritance applies only to UOA system roles, not to custom roles.

1. Org `owner` → effective `owner` on every team in the org
2. Org `admin` → effective `admin` on every team in the org
3. A user with an explicitly higher team role than their org role keeps the higher team role
4. Inheritance is computed at request time — not stored as duplicate records

Custom roles do not inherit. If a consuming app wants custom role inheritance, it implements that in its own gating layer.

---

## Email domain auto-enrolment

Orgs can define rules so that any user who authenticates with a verified email from a given domain is automatically granted membership on first login.

Each rule specifies:
- Email domain (e.g. `acme.com`)
- UOA role to grant — `admin`, or neither (plain member)
- Verification method required: `ANY`, `EMAIL`, `GOOGLE`, `GITHUB`, `MICROSOFT`

On auto-enrolment the user receives the **default custom role** of the team they are added to. The rule does not need to specify a custom role explicitly.

`owner` can never be granted via auto-enrolment.

---

## Who can manage custom role definitions

Only the **team admin** and the **org owner** can create, rename, delete, or change the default custom role for a team.

---

## Enterprise features (in scope from the start)

### Microsoft SSO (Azure AD / Entra ID)

Required for enterprise clients (e.g. automotive, manufacturing, finance) whose employees authenticate via corporate Microsoft accounts.

- Add Microsoft OAuth 2.0 / OIDC as a supported social login provider alongside Google and GitHub
- Employees sign in with `user@ford.com` or `user@skoda-auto.cz` via their corporate Entra ID
- Verified Microsoft identity qualifies as `ANY` or `MICROSOFT` verification method for auto-enrolment rules
- Token includes `method: "microsoft"` alongside existing `google`, `github`, `email`

### SCIM provisioning (Entra ID / Okta)

Required for enterprise clients who manage thousands of users via a central identity provider and cannot manage membership manually.

SCIM (System for Cross-domain Identity Management) is the protocol identity providers like Microsoft Entra ID and Okta use to push user and group changes into external apps automatically. When an employee joins Ford, Entra ID provisions them into UOA. When they leave, it deprovisions them. Groups in Entra ID map to teams in UOA.

UOA must expose a SCIM 2.0 endpoint:

```
POST   /scim/v2/Users          — provision a new user
GET    /scim/v2/Users/:id      — read user
PATCH  /scim/v2/Users/:id      — update user attributes / active status
DELETE /scim/v2/Users/:id      — deprovision (ban or remove from org)
GET    /scim/v2/Groups         — list groups (maps to teams)
POST   /scim/v2/Groups         — create team via IdP
PATCH  /scim/v2/Groups/:id     — add/remove members, rename team
DELETE /scim/v2/Groups/:id     — delete team
```

SCIM group membership maps to UOA team membership. The custom role assigned to SCIM-provisioned members defaults to the team's default custom role unless the IdP sends a role attribute.

SCIM endpoints are authenticated with a long-lived bearer token issued per org, managed via the admin panel.

---

## Role model decision — three options, analysis

This is an open architectural decision. Three viable approaches exist for how a user's custom roles are modelled per team.

### Option A — Multiple roles per user

A user can hold several custom roles simultaneously on the same team: `["editor", "billing"]`.

**Pros**
- Naturally models reality — a person can be an editor *and* handle billing without needing a combined role
- No role explosion — define N atomic roles, combine freely
- Changing one dimension of access doesn't affect others
- Consuming app checks `roles.includes('billing')` per capability

**Cons**
- Token grows as role combinations increase
- Access logic spreads across the consuming app's codebase — no single place to answer "what kind of user is this?"
- Harder to explain to end users and admins ("you have: editor, billing, content-reviewer")
- Role combinations can produce unintended interactions if not carefully designed on the consuming app's side

---

### Option B — More granular single roles, server-side gating

Define enough roles that every combination of access needs gets its own named role: `editor`, `billing-editor`, `read-only-viewer`, `senior-editor`, etc. One role per user per team. The consuming app gates features by checking the role name.

**Pros**
- Simplest mental model — one role, one identity, one place to check
- Easy to display: "you are a Billing Editor"
- Auditable — role assignments are explicit
- Common pattern, well understood

**Cons**
- Role explosion as the product grows — every new capability combination requires a new role
- Adding capabilities requires new role definitions and code changes on the consuming app side
- Admins must understand a large, growing list of roles
- Combining two users' access (one person covering two jobs) means creating a combined role

---

### Option C — Feature flags per role (UOA as a feature flag store)

Each custom role has a set of boolean flags attached: `{ canPublish: true, canEditBilling: false }`. UOA stores flag definitions per org/team and returns them in the token alongside the role. The consuming app checks flags rather than role names.

**Pros**
- Consuming app never needs to know role names — just checks `flags.canPublish`
- Adding new capabilities doesn't require new roles or code deploys on the consuming app side
- Org admins can adjust flags without touching app code
- Reduces coupling between UOA's role labels and the consuming app's feature names

**Cons**
- UOA becomes opinionated about the consuming app's internal features — leaks application concerns into the auth layer
- Flag definitions must be created, maintained, and versioned in UOA — additional operational surface
- Consuming apps may not trust externally defined flags for security-critical decisions (the flag is just data; the check still happens in their code)
- Flags and role permissions are distinct concepts being merged, which can become confusing as both evolve
- Significantly more complex admin UI and data model in UOA

---

### Recommendation

**Option A as the default**, with Option C as an optional enterprise add-on.

Option A gives consuming apps the flexibility they need without forcing UOA to model their internal feature space. The consuming app defines the roles, assigns them, and interprets combinations itself. Option B creates unsustainable role lists at scale. Option C is powerful but risks scope creep into territory that belongs to the consuming app — the right pattern for that is the consuming app having its own feature flag system (LaunchDarkly, etc.) keyed on the role UOA returns, not UOA doing it for them.

If there is strong market demand for Option C from enterprise clients, it can be introduced as a paid feature on top of Option A without breaking existing integrations.
