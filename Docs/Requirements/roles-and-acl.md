# Roles & ACL — Requirements

## Two distinct role systems

There are two completely separate concepts that must not be conflated.

### 1. UOA system roles (internal)

These control who can administer the UOA backend itself. They are fixed and managed only by system admins via the admin panel. End users and developers never see or configure these.

| Role | Scope | Can do |
|---|---|---|
| `system_admin` | Global | Full admin panel access, all orgs/teams/domains |
| `org_owner` | Organisation | Manage their org, teams, members, domains |
| `org_admin` | Organisation | Manage teams and members, not delete org |
| `org_member` | Organisation | Read-only on org structure |
| `team_owner` | Team | Manage team members and domain rules for that team |
| `team_admin` | Team | Manage team members |
| `team_member` | Team | Basic membership |

These roles are stored and managed by UOA. They drive access to the UOA admin panel and to management API endpoints (`/internal/...`).

### 2. Consumer-defined roles (external, custom)

These are the roles that a developer registering a domain/team defines for their own product. UOA does not know or care what they mean — it stores and returns them. The developer decides what `editor`, `viewer`, `staff`, `bartender`, or anything else means inside their own application.

UOA's responsibility:
- Store the custom role definitions per team
- Assign custom roles to users per team
- Return the user's custom roles in the access token and via API
- Enforce nothing — the consuming app enforces meaning

These are entirely separate from UOA system roles.

---

## Hierarchy model

```
Organisation
  ├── has many Domains          (multiple — one org may run hundreds of services)
  ├── has many Teams
  │     ├── Team has one or more Domains
  │     ├── Team has custom Role definitions
  │     └── Team has Members (with custom roles assigned)
  └── has system-level role assignments per member
```

### Auto-organisation rule

Not every user of UOA needs an enterprise org setup. Teams are the primary registration unit for simpler setups.

**Rule:** When a team is created and no organisation is specified, an organisation is automatically created with the same name/slug and the team placed under it. That org is allowed to contain only one team (the simple/non-enterprise case). If the org later needs to expand to multiple teams, it is promoted to a full enterprise org by adding a second team.

This means:
- Teams are always under an org, but the org can be implicit/auto-created
- Single-team orgs are the default, lightweight path
- Multi-team orgs are the enterprise path

### Domain assignment

- Domains live at **organisation level** — an org can have multiple domains (e.g. `api.acme.com`, `app.acme.com`, `admin.acme.com`, `mobile.acme.com`, ...)
- A **team** references one or more domains from its org's domain pool — this is what gets registered; the team is the entity that "uses" a domain
- A domain can only belong to one organisation
- Authentication requests come in on a domain → resolve to the org → resolve to the team registered for that domain → determine user's membership and roles for that team

---

## Custom role definitions

Each team defines its own set of role names. These are free-form strings stored per team.

```json
{
  "teamId": "team_abc",
  "customRoles": ["editor", "viewer", "staff", "manager"]
}
```

When a user is added to a team, they are assigned one of those custom roles.

UOA validates only:
- The role name assigned to a user must exist in the team's `customRoles` list
- Role names must be non-empty strings, no spaces, reasonable length

UOA does **not** validate meaning or enforce permissions based on custom roles — that is the consuming app's responsibility.

### Token output

The access token issued by UOA includes:

```json
{
  "sub": "user_123",
  "email": "alice@acme.com",
  "orgs": [
    {
      "id": "org_abc",
      "slug": "acme",
      "uoaRole": "org_member",
      "teams": [
        {
          "id": "team_xyz",
          "name": "Backend",
          "domain": "api.acme.com",
          "customRole": "editor",
          "uoaRole": "team_member",
          "uoaRoleInherited": true
        }
      ]
    }
  ]
}
```

`uoaRole` = UOA system role (internal, for UOA management use)  
`customRole` = developer-defined role (for the consuming app to use)  
`uoaRoleInherited` = true if the team-level UOA role was not set explicitly but inherited from the org

---

## Inheritance rules (UOA system roles only)

Custom roles do not inherit — the consuming app defines its own hierarchy if it wants one.

UOA system role inheritance:

1. `org_owner` → effective `team_owner` on every team in the org
2. `org_admin` → effective `team_admin` on every team in the org
3. `org_member` → effective `team_member` on every team (read access only)
4. A user with an explicit team role at a higher level than their org role keeps the higher team role

Inheritance is computed at access time, not stored as duplicate records.

---

## Email domain auto-enrolment

Orgs (and by extension teams) can define rules: any user who authenticates with a verified email from `@acme.com` is automatically added to the org as `org_member` and to the default team with a specified custom role.

Rules are per-org and specify:
- Email domain (e.g. `acme.com`)
- UOA role granted (`org_member` or `org_admin` — never `org_owner`)
- Custom role granted on the default team (must exist in that team's `customRoles`)
- Verification method required (`ANY`, `EMAIL`, `GOOGLE`, `GITHUB`)

---

## Outstanding decisions needed

1. **Can a custom role be the same string as a UOA system role?** (e.g. can a developer name a role `admin`?) — recommend: yes, no conflict since they live in different namespaces
2. **Role name format** — allow any string, or enforce lowercase/alphanumeric/hyphen?
3. **Max custom roles per team** — suggest: 20
4. **Who can manage custom role definitions?** — suggest: `team_owner` and `org_owner` only
5. **Default custom role on auto-enrolment** — must be pre-configured per rule, or fallback to first role in the list?
6. **SCIM provisioning** — out of scope for now but the custom role model needs to be SCIM-group-compatible for future enterprise IdP sync
