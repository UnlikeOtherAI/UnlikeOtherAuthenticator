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

- Any number of custom roles per team or organisation — no cap, no gating
- Custom roles can share names with UOA system roles (different namespaces, no conflict)
- A user's UOA role and their custom role are completely orthogonal: an `owner` in UOA can be a `viewer` in the app; a plain user in UOA can be a `superadmin` in the app

UOA's only responsibilities for custom roles:
- Store the role definitions per team/org
- Validate that a role assigned to a user exists in the team/org's defined list
- Return the role label in the access token and via API
- Enforce nothing beyond that

---

## Hierarchy model

```
Organisation
  ├── has many Domains     (multiple — one org can serve hundreds of services)
  ├── has UOA role assignments (owner, admin) per member
  ├── has custom role definitions
  └── has many Teams
        ├── references one or more Domains from the org's domain pool
        ├── has UOA role assignments (owner, admin) per member
        ├── has custom role definitions (can differ from org-level)
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

Each team (and optionally org) defines its own role names as a simple list of strings:

```json
{
  "teamId": "team_abc",
  "customRoles": ["editor", "viewer", "staff", "manager"]
}
```

No limit on the number of roles. Role names are validated only for being non-empty strings. Format is up to the defining org — UOA imposes no casing or character rules beyond that.

What a role *permits* inside the consuming application is entirely that application's concern. UOA returns only the label.

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

- `uoaRole` — `owner`, `admin`, or omitted if neither. For UOA management use only.
- `uoaRoleInherited` — true if the team-level UOA role was derived from the org-level role, not set explicitly
- `customRoles` — array of the consuming app's role labels for that scope. UOA stores and returns them; the app interprets them.

Note: `customRoles` is an array because a user may hold multiple custom roles at the same scope (e.g. `["editor", "billing"]`).

---

## UOA system role inheritance

Inheritance applies only to UOA system roles, not to custom roles.

1. Org `owner` → effective `owner` on every team in the org
2. Org `admin` → effective `admin` on every team in the org
3. A user with an explicitly higher team role than their org role keeps the higher team role
4. Inheritance is computed at request time — not stored as duplicate records

Custom roles do not inherit. If a consuming app wants role inheritance, it implements that in its own gating layer.

---

## Email domain auto-enrolment

Orgs can define rules so that any user who authenticates with a verified email from a given domain is automatically granted membership on first login.

Each rule specifies:
- Email domain (e.g. `acme.com`)
- UOA role to grant — `admin` only, or neither (plain member with no UOA role)
- Custom role(s) to assign on the default team — must exist in the team's defined list
- Verification method required: `ANY`, `EMAIL`, `GOOGLE`, `GITHUB`

`owner` can never be granted via auto-enrolment — ownership is always explicit.

---

## Who can manage custom role definitions

Only the **team admin** and the **org owner** can create, rename, or delete custom role definitions for a team. No other role has this permission.

---

## Outstanding decisions

1. **Default custom role on auto-enrolment** — must the rule explicitly name a custom role, or fall back to the first role in the team's list if none specified?
2. **Multiple custom roles per user per team** — the token uses an array; confirm this is intentional (a user can hold `editor` and `billing` simultaneously at the same team scope)
