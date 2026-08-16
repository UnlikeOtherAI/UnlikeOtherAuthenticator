# The role model — three tiers, one authority

> **Status:** proposal, 2026-08-16. Written after auditing the roles that
> actually exist in UOA and in all six consuming products.
> **Short answer to the question that prompted it:** there is no team-level
> super-admin anywhere in the estate. The concept you were worried about does
> not exist, and nothing needs deleting. What does need fixing is smaller and
> more specific: one product treats platform super-admin as a local flag, the
> products carry a fourth role UOA does not model, and only UOA implements
> "an org manager overrules a team".

## What exists today (verified in source)

### UOA — already the model you described

| Tier | Where | Values |
|---|---|---|
| Platform | `UserRole` enum on the user row | `SUPERUSER` \| `USER` — 9 checks in `API/src`, all deployment-operator concerns (billing admin effects, org-creation bypass, internal admin) |
| Organisation | `OrganisationMember.role` | `owner` \| `admin` \| `member`, validated against the `org_roles` config |
| Team (workspace) | `TeamMember.teamRole` | `owner` \| `admin` \| `member` |

And the cross-tier rule you asked whether we might want **is already
implemented**: `isOrgOrTeamManager` (`team.service.base.ts`) returns true when
the actor is an org owner/admin, *without requiring team membership at all*,
before it even looks at the team role. An organisation manager already
overrules within its teams. Backend mode (domain pairing, no acting user)
outranks both — deliberately, and documented as such.

So UOA needs no new roles. It is the reference.

### The products — three deviations, none of them a team super-admin

1. **A fourth role: `viewer`.** Every Node product carries
   `owner | admin | member | viewer`; UOA models only three. In Nessie the
   extra role is used at *product* scopes (channel, project, dashboard), which
   UOA does not model at all — so it is not a duplicate of a UOA role, but the
   vocabulary reads as though it were.
2. **Platform super-admin as a local flag.** Nessie's `User.superAdmin` is a
   boolean column "granted out-of-band", set by a CLI keyed on **email**
   (`cli/src/super-admin.ts`). UOA already knows who is a `SUPERUSER`. Under
   the estate's own non-duplication rule this is a local copy of a UOA-owned
   fact — the same class of problem as a local email column, and the last one
   still standing after today's work. water, DeepTest and AdGoes have
   super-admin concepts too; DeepSignal has none; docgen has only `admin` and
   no ladder at all.
3. **No product implements "org manager overrules team."** Authority is
   membership-scoped everywhere: an org owner who is not a member of a team
   has no standing in it. That is a *stricter* posture than UOA's, so nothing
   is unsafe — but it means an org admin cannot fix a workspace they own,
   which is exactly the capability you were reaching for.

## Proposal

### 1. Three tiers, and only three

| Tier | Who | Owns |
|---|---|---|
| **Platform super-admin** | Operators of the deployment | The instance: health, queues, the public connector store, instance-global catalog rows. **Never a customer role.** |
| **Organisation** `owner` / `admin` / `member` | The customer's own administration | Users, invitations, teams, billing. `owner` additionally: delete the org, transfer ownership, and the last-owner invariant. |
| **Team (workspace)** `owner` / `admin` / `member` | Per-workspace administration | That workspace's roster, settings and product resources. |

This is the industry-standard shape — GitHub (enterprise owner → org owner →
team maintainer), Google Workspace (super admin → org admin → group manager),
Slack (org owner → workspace admin) all land here — and it is what UOA already
implements. Nothing in the estate needs a fourth tier.

### 2. Org managers overrule teams (adopt UOA's rule everywhere)

An organisation `owner` or `admin` has the authority of a team `admin` in
**every** team of that organisation, without a `TeamMember` row. Rationale
beyond convenience: without it, an org admin cannot recover a workspace whose
only owner has left, which is a support burden that ends in someone editing
the database. UOA already answers this way, so products adopting it become
*consistent* with the authority rather than diverging from it.

Implementation is one shared predicate, not six: `deep.admin`'s
`uoa-rp-node` should expose `isOrgOrTeamManager(ctx, teamId)` mirroring UOA's,
and products call it wherever they currently check team membership for a
management action.

### 3. Platform super-admin is mirrored from UOA, never granted locally

`User.superAdmin` (and its siblings in water, DeepTest, AdGoes) becomes a
**projection of UOA's `UserRole.SUPERUSER`**, carried in the verified claims
and re-derived at login and refresh exactly as org and team roles now are.
Delete the email-keyed CLI grant. A product must not be able to mint an
instance administrator that UOA does not know about — and today it can.

This is the same rule the whole estate already follows for org and team roles;
super-admin is simply the last role that escaped it.

### 4. Keep `viewer`, but only below the org/team line

The boundary that keeps this honest:

> **UOA owns the role at organisation and team scope. A product may define
> roles only for scopes UOA does not model** — channel, project, dashboard,
> knowledge space.

So `viewer` stays where Nessie uses it (product scopes) and must never appear
as an org or team membership role. docgen, which has only `admin`, adopts the
three-tier ladder for org/team and keeps whatever it needs below.

### 5. What does *not* change

Nessie's deny-overrides policy engine (org → project → team → channel → agent
→ tool → user) is a **policy** mechanism, orthogonal to roles: it decides what
a rule says, not who is senior to whom. Nothing here touches it. Likewise
UOA's backend-mode override (domain pairing outranks any user role) stays as
is — it is how a product's own backend acts, not a human role.

## Work this implies

| # | Change | Where | Size |
|---|---|---|---|
| 1 | Expose `SUPERUSER` in the verified claims; mirror it in products; delete local grants | UOA + Nessie, water, DeepTest, AdGoes | Medium |
| 2 | Shared `isOrgOrTeamManager` in `uoa-rp-node`; adopt at management call sites | deep.admin + all products | Medium |
| 3 | Forbid `viewer` at org/team scope; document the boundary | All products | Small |
| 4 | Give docgen the full org/team ladder | docgen | Small |
| 5 | State the three tiers and the boundary in the estate rule | `docs/brief.md`, product `CLAUDE.md`/`AGENTS.md` | Small |

Item 1 is the one with a security edge — a locally-granted instance
administrator is invisible to the authority — and item 2 is the one that
changes what an org admin can actually do. The rest is vocabulary hygiene.

## The question this proposal does not answer

Whether an organisation `admin` should be able to *remove the last owner of a
team* or only add themselves alongside. UOA's predicate says yes; that is a
product decision about destructive actions rather than about roles, and it
should be settled per action rather than in the role model.
