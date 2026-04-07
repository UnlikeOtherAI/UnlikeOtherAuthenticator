# API Changes Required — ReBAC Permission Model

This document describes what needs to change in the API (`/API`) to implement the Zanzibar-style relationship-based access control model described in `Docs/Research/acl-auth-model.md`.

The model uses three layers — **Organisation → Team → Member** — with roles assignable at any layer and downward inheritance (an org-level role implies team-level authority). Email domain auto-enrolment replaces the previous concept of orgs being tied to a specific client domain.

---

## 1. Schema changes (Prisma)

### Remove
- `Organisation.domain` field — orgs are not tied to a single client app domain. Users access orgs through whichever domain they authenticated with.

### Add

#### `OrgEmailDomainRule`
Replaces the old `domain` association. Drives automatic org membership on first verified login.

```prisma
model OrgEmailDomainRule {
  id           String   @id @default(cuid())
  orgId        String
  org          Organisation @relation(fields:[orgId], references:[id], onDelete:Cascade)
  emailDomain  String   // e.g. "acme.com" — no @ prefix, lowercase
  grantedRole  OrgRole  // role assigned on auto-enrolment
  verification VerificationMethod // ANY | EMAIL | GOOGLE | GITHUB
  createdAt    DateTime @default(now())

  @@unique([orgId, emailDomain])
}

enum VerificationMethod {
  ANY       // any verified identity (email link, Google, GitHub, Microsoft, etc.)
  EMAIL     // email link only
  GOOGLE
  GITHUB
  MICROSOFT // Microsoft Entra ID / Azure AD OIDC
}
```

#### `OrgRole` enum (if not already defined)
```prisma
enum OrgRole {
  owner   // non-removable, transferable; implicitly has all admin capabilities
  admin   // full power: manage members, teams, billing, domains
  member  // DB-level value only — not a named UOA system role. Users without owner/admin are plain members.
}
```

#### `TeamRole` enum — standardise to same 3 levels
```prisma
enum TeamRole {
  owner   // non-removable, transferable
  admin   // full power on this team
  member  // DB-level value only — not a named UOA system role
}
```

Replace any existing `lead` value with `admin` in migration.

#### `RelationshipTuple` (optional — for future Zanzibar migration)
If adopting OpenFGA or SpiceDB later, add a relationship tuple table now so you can dual-write and migrate without downtime:

```prisma
model RelationshipTuple {
  id          String   @id @default(cuid())
  objectType  String   // "org" | "team"
  objectId    String
  relation    String   // "owner" | "admin" | "member" | "parent"
  subjectType String   // "user" | "team" | "org"
  subjectId   String
  subjectRel  String?  // for userset references e.g. "member"
  condition   Json?    // optional ABAC-style conditions
  createdAt   DateTime @default(now())

  @@index([objectType, objectId, relation])
  @@index([subjectType, subjectId])
}
```

---

## 2. New API endpoints

### Email domain auto-enrolment rules

```
GET    /org/:orgId/domain-rules          — list rules for an org
POST   /org/:orgId/domain-rules          — add a rule
DELETE /org/:orgId/domain-rules/:ruleId  — remove a rule
```

Request body for POST:
```json
{
  "emailDomain": "acme.com",
  "grantedRole": "member",
  "verification": "ANY"
}
```

Validation:
- `emailDomain` must be a valid domain (no `@`, no protocol, lowercase)
- `emailDomain` must not already exist for this org
- `grantedRole` cannot be `owner` (owners must be explicitly assigned)
- Caller must be org `owner` or `admin`

### Permission check endpoint (for internal use / future)

```
POST /internal/permission/check
```

Body:
```json
{
  "userId": "...",
  "objectType": "org" | "team",
  "objectId": "...",
  "relation": "owner" | "admin" | "member"
}
```

Returns `{ allowed: true | false, source: "direct" | "inherited" | "domain-rule" }`.

Used by middleware to avoid repeating inheritance logic across routes.

---

## 3. Changes to existing endpoints

### `POST /org` — create organisation
- Remove `domain` from request body
- Add optional `emailDomainRules` array in body (creates rules atomically with the org)
- Auto-create default `General` team with `isDefault: true` (already done)

### `POST /auth/login` and `POST /auth/social` — auto-enrolment on first login
After a user successfully authenticates (email verified or social login confirmed), run auto-enrolment:

```ts
// pseudo-code
const verifiedEmail = user.email; // already verified
const emailDomain = verifiedEmail.split('@')[1];

const matchingRules = await prisma.orgEmailDomainRule.findMany({
  where: {
    emailDomain,
    verification: { in: applicableVerificationMethods(loginMethod) }
  },
  include: { org: true }
});

for (const rule of matchingRules) {
  const existing = await prisma.orgMember.findFirst({
    where: { orgId: rule.orgId, userId: user.id }
  });
  if (!existing) {
    await prisma.orgMember.create({
      data: { orgId: rule.orgId, userId: user.id, role: rule.grantedRole }
    });
    // Also add to the org's default team
    const defaultTeam = await prisma.team.findFirst({
      where: { orgId: rule.orgId, isDefault: true }
    });
    if (defaultTeam) {
      await prisma.teamMember.create({
        data: { teamId: defaultTeam.id, userId: user.id, role: 'member' }
      });
    }
  }
}
```

`applicableVerificationMethods(loginMethod)`:
- Google login → matches `ANY`, `GOOGLE`
- GitHub login → matches `ANY`, `GITHUB`
- Microsoft login → matches `ANY`, `MICROSOFT`
- Email verified → matches `ANY`, `EMAIL`

### `GET /user/me` and access token payload
Add to token claims:
```json
{
  "orgs": [
    {
      "id": "org_abc",
      "slug": "acme-engineering",
      "uoaRole": "admin",           // org-level UOA system role; omitted if plain member
      "customRole": "manager",      // consuming app's role label; omitted if none assigned
      "teams": [
        { "id": "team_xyz", "name": "Backend", "uoaRole": "admin", "uoaRoleInherited": false, "customRole": "editor" },
        { "id": "team_abc", "name": "General", "uoaRoleInherited": false, "customRole": "viewer" }
      ]
    }
  ]
}
```

- `uoaRole` — `owner` or `admin`; omitted if neither
- `uoaRoleInherited` — `true` if the team role was computed from org-level role, not explicitly set
- `customRole` — the consuming app's single role label for this team membership; omitted if none

### `GET /org/:orgId/members` — include role inheritance
Response should include `effectiveTeamRole` alongside the explicit team role so callers can show "inherited from org" in UI.

---

## 4. Middleware changes

### Permission guard (replaces direct role checks)

Create `API/src/middleware/org-permission.ts`:

```ts
export function requireOrgRole(minRole: OrgRole) {
  return async (req, reply) => {
    const userId = req.user.id;
    const orgId = req.params.orgId;
    const member = await prisma.orgMember.findFirst({ where: { userId, orgId } });
    if (!member || !roleAtLeast(member.role, minRole)) {
      throw new AppError('Forbidden', 403);
    }
  };
}

// Role hierarchy: owner > admin > member
function roleAtLeast(actual: OrgRole, required: OrgRole): boolean {
  const order: OrgRole[] = ['member', 'admin', 'owner'];
  return order.indexOf(actual) >= order.indexOf(required);
}
```

Create `API/src/middleware/team-permission.ts` with similar logic, but check team membership first, then fall back to org-level role (inheritance):

```ts
export function requireTeamRole(minRole: TeamRole) {
  return async (req, reply) => {
    const userId = req.user.id;
    const teamId = req.params.teamId;

    // Direct team membership
    const teamMember = await prisma.teamMember.findFirst({ where: { userId, teamId } });
    if (teamMember && roleAtLeast(teamMember.role, minRole)) return;

    // Fall back to org-level role (inheritance)
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (team) {
      const orgMember = await prisma.orgMember.findFirst({
        where: { userId, orgId: team.orgId }
      });
      if (orgMember && roleAtLeast(orgMember.role as OrgRole, minRole as any)) return;
    }

    throw new AppError('Forbidden', 403);
  };
}
```

---

## 5. Token payload changes

The access token JWT (signed via `signAccessToken`) needs the full org/team/role graph embedded:

```ts
interface AccessTokenPayload {
  sub: string;           // userId
  email: string;
  orgs: OrgClaim[];
}

interface OrgClaim {
  id: string;
  slug: string;
  role: OrgRole;         // direct org-level role
  teams: TeamClaim[];
}

interface TeamClaim {
  id: string;
  name: string;
  role: TeamRole;        // effective role (direct or inherited)
  inherited: boolean;    // true if derived from org role, not explicit team assignment
}
```

Note: Token size increases with number of orgs/teams. The `max_team_memberships_per_user` config cap (already in the system) becomes important here.

---

## 6. Admin API endpoints (new)

The admin panel will need dedicated endpoints in `/internal/admin/`:

```
GET    /internal/admin/orgs                          — paginated org list
GET    /internal/admin/orgs/:orgId                   — org detail with rules
GET    /internal/admin/orgs/:orgId/domain-rules      — email domain rules
POST   /internal/admin/orgs/:orgId/domain-rules      — add rule
DELETE /internal/admin/orgs/:orgId/domain-rules/:id  — remove rule
PATCH  /internal/admin/orgs/:orgId/members/:userId   — change org role
DELETE /internal/admin/orgs/:orgId/members/:userId   — remove from org
PATCH  /internal/admin/teams/:teamId/members/:userId — change team role
```

All require system admin authentication (existing domain-hash auth with the admin domain, or a separate system admin JWT).

---

## 7. Brief update required

`Docs/brief.md` section 22.3 ("one global shared secret, no per-domain secrets") is not affected by these changes — that refers to client app domain secrets, which are separate from email domain auto-enrolment rules.

The following new concepts need to be added to the brief:
- Email domain auto-enrolment rules per organisation
- `OrgRole` and `TeamRole` enums with defined hierarchy (`owner > admin > member`)
- Role inheritance: org-level role implies equivalent team-level access
- `VerificationMethod` enum for enrolment eligibility
