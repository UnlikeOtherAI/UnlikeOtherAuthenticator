# Configurable roles and capabilities — the domain defines the words, the product defines the deeds

> **Status:** proposal, 2026-08-16. Replaces the refuted three-tier proposal
> (`2026-08-16-estate-role-model.md`, stamped ⛔ do not implement); every claim
> below was re-verified in source rather than inherited from it.
> **The ask, in the owner's words:** roles should be configurable per domain in
> the SSO so the vocabulary is defined once and never duplicated, and each
> product gates its own functionality against whatever the domain configured.
> And: *"It is important that each team can have admins, to worry about billing
> and team members and stuff. Obviously, unless the billing is outsourced to the
> parent company, and then we need a custom list of different things we're going
> to do to get different functionalities for different users."*
>
> Three design constraints fall straight out of that sentence and are treated as
> first-class throughout: a team admin is **self-sufficient** (members *and*
> billing, no org standing needed); a capability can be **conditionally
> withdrawn by org state** (billing assumed by the parent org), so resolution
> takes context, not just a role name; and the different-things-for-different-
> users list is **configuration, not code**.

## The one-sentence design

**UOA owns the role vocabulary per domain and the per-domain binding of roles
to capability names; each product owns its capability names and gates every
action on a capability, never on a role string; the shared resolver fails
closed, so a role the binding does not mention can do nothing.**

Roles are adjectives the customer chooses. Capabilities are verbs the product
compiled in. The grant table — which adjectives get which verbs — is the only
part that is configurable, and it lives in the one signed artifact both sides
already trust: the domain config.

## What exists today (verified in source, 2026-08-16)

### The authority is already half-built — and half-contradicts itself

| Fact | Where | Consequence |
|---|---|---|
| `org_roles` is **already per-domain configurable**: arbitrary strings (1–50 chars), only `owner` mandatory, default `['owner','admin','member']` | `API/src/services/config.service.ts:276-280` | The owner's instinct is half-shipped |
| Team roles are a **fixed three** | `team.service.base.ts:80` `ALLOWED_TEAM_ROLES = {'owner','admin','member'}` | The tier the owner's sentence is about is the one that is *not* configurable |
| UOA's own gates hard-code `owner\|admin` | `team.service.base.ts:204` `isTeamManager(role) { return role === 'owner' \|\| role === 'admin' }` | A custom configured role has **no authority inside UOA itself** — you can name it, but it cannot manage anything |
| The roster mutation gate checks **only the org role** | `team.service.base.ts:281` `requireTeamManager` reads the org membership alone | A team `owner`/`admin` cannot administer their own team's roster through UOA — directly against the owner's constraint #1 |
| Groups exist as a fourth role-bearing tier: `GroupMember.isAdmin` → `group_admin[]` claim | `prisma/schema.prisma:1438-1444`, `services/org-context.service.ts:128-139` | Projected into claims; **zero consumers estate-wide** (grep across all six products: no reference outside UOA) |
| Membership writes are validated against the configured vocabulary | `organisation.service.base.ts:280` `resolveOrgRoles` | Garbage roles cannot be minted — the vocabulary is enforced at the write |

So the configurable half (vocabulary) exists and the load-bearing half (what a
role may *do*) is hard-coded even in the authority. Adding `auditor` to a
domain's `org_roles` today produces a member who can be listed, invited and
displayed — and whose actual power is decided by six products' accident of
string handling, which is the next table.

### The products inflate unknown roles — three of them, not two

| Product | Site | Behaviour on an unknown role |
|---|---|---|
| DeepSignal | `api/src/auth/uoa.ts:169-174` `mapRole` | `RoleSchema.safeParse(...)` fails → **`'member'`** |
| Nessie | `api/src/services/uoa-roles.ts` `mapUoaMemberRole` | `switch` `default:` → **`'member'`** |
| docgen | `platform_api/uoa_roles.py` `normalise_role` | documented as deliberate: *"An unrecognised value is `member` … must never grant more than the floor"* → **`'member'`** |
| deep.admin | `packages/uoa-rp-node/src/directory-client.ts:126-131` `parseRole` | **`null`** — the correct shape |

The docgen entry is the instructive one: it *believes* it is failing closed,
because it calls `member` "the floor". But `member` is not a floor — in every
product it is write capability (post, create, upload, spend). The moment a
domain configures a fourth org role, three products grant it write access. And
the inflation runs in both directions: Nessie's own `MemberRole` enum carries
`viewer` (`api/prisma/schema.prisma:271-276`, offered in the Members dropdown),
so a domain that configures `viewer` as a UOA org role — the obvious first
custom role — gets it coerced to `member` by `mapUoaMemberRole`, silently
**promoting the one role whose entire point is not writing**.

### The products already carry vocabularies UOA does not model

| Product | Vocabulary | Scope |
|---|---|---|
| docgen | `viewer < reviewer < editor < admin < owner` (`ROLE_ORDER`, `_ROLE_RANK`) | per-project (`ProjectMember`) |
| AdGoes | `admin \| editor \| viewer` (`adPlatformOAuthCallbackService.ts:6`) | per ad-platform connection |
| Nessie | `owner \| admin \| member \| viewer` | org/project/team membership |
| water | `admin \| member` only (`workspace-members.ts:67`) | team |
| DeepSignal | `owner \| admin \| member \| guest` (`auth/team-role.ts` treats `guest` as outsider) | team |
| DeepTest | `owner \| admin \| member` (`uoa-teams.ts:34-35`) | team |

Read that table as demand, not drift: water wants a **two**-role team, Nessie
and DeepSignal want a **four**-role team (a read-only tier and a guest tier),
and the fixed `ALLOWED_TEAM_ROLES` forces every one of them to fake it locally.
That is the argument for making team roles configurable, and it is the same
argument that already carried `org_roles`.

## Design

### 1. The split: vocabulary and grants are configured; capabilities are code

Three artifacts, three owners:

| Artifact | Owner | Form | Why there |
|---|---|---|---|
| **Role vocabulary** | the domain (customer/deployment) | `org_roles` (exists) + `team_roles` (new), strings, `owner` mandatory in both | Words are the customer's; UOA validates every membership write against them, so the vocabulary is enforced, not advisory |
| **Capability catalogue** | the product, in code | a closed, versioned set of capability names, declared once and mirrored into the domain config for validation | Only code can enforce a verb; a capability nobody's code checks is a lie |
| **Grant table** (`role_grants`) | the domain, in config | role → capability-name list, per scope | The binding is the only genuinely configurable part — "different functionalities for different users" |

All three live in (or are mirrored into) the **domain config JWT** — the same
product-authored, product-signed document that already carries `org_roles`.
That is what "defined once and never duplicated" cashes out to: one signed
artifact, read by UOA (to validate membership writes and the grant table's
internal coherence) and by the product (to resolve capabilities), with no new
storage, no new admin surface, and versioning for free. A UOA-hosted editing UI
can be added later; it would edit this document, not introduce a second one.

The config schema gains (in `org_features`):

```jsonc
{
  "org_roles":  ["owner", "admin", "member", "auditor"],
  "team_roles": ["owner", "admin", "member", "viewer"],   // NEW — same rules as org_roles: strings, must include "owner"
  "capabilities": [                                        // NEW — the product's declared catalogue, for validation only
    "workspace.read", "content.write", "channels.manage",
    "members.manage", "agents.create", "agents.administer",
    "connectors.self", "connectors.shared", "ops.telemetry",
    "billing.manage"
  ],
  "role_grants": {                                         // NEW — the binding
    "org": {
      "admin":   ["members.manage", "connectors.shared", "ops.telemetry",
                  "workspace.read", "content.write"],
      "member":  ["workspace.read", "content.write", "channels.manage",
                  "agents.create", "connectors.self"],
      "auditor": ["workspace.read"]
    },
    "team": {
      "admin":   ["members.manage", "billing.manage", "channels.manage",
                  "agents.administer", "workspace.read", "content.write"],
      "member":  ["workspace.read", "content.write", "channels.manage",
                  "agents.create", "connectors.self"],
      "viewer":  ["workspace.read"]
    }
  }
}
```

Validation, at config load (`config.service.ts`), all fail-loud:

- every key in `role_grants.org` ∈ `org_roles`, every key in `role_grants.team`
  ∈ `team_roles`;
- every capability name ∈ `capabilities`;
- `owner` **may not appear** in `role_grants` — see below;
- a role present in the vocabulary but absent from `role_grants` is legal and
  means *no capabilities*: membership, visibility in the roster, nothing else.
  Absence is the explicit floor, and the floor is empty.

**`owner` is the one fixed role.** It implicitly holds every capability at
every scope it stands in, and that is structural, not configured — which is why
it is barred from the grant table. Two reasons: `owner` already carries fixed
semantics UOA enforces (mandatory in the vocabulary, last-owner invariant, org
deletion), and a domain must not be able to write a config that locks its own
owner out of the ability to fix the config. Owner is the recovery role;
everything else is vocabulary plus grants.

**Rank is dead.** The refuted proposal ordered roles on a ladder; docgen ranks
them numerically (`_ROLE_RANK`). This design deliberately has no ordering at
all — `auditor` above is neither above nor below `member`, it is a different
*set*. Orderings are what made "coerce unknown to member" look like a safe
default; sets make "unknown = empty set" the only sensible one.

### 2. What a call site looks like

The product declares its catalogue once, in code, as a typed constant:

```ts
// nessie: packages/schemas/src/capabilities.ts
export const NESSIE_CAPABILITIES = defineCapabilities({
  'workspace.read':    { scope: 'team' },
  'content.write':     { scope: 'team' },
  'channels.manage':   { scope: 'team' },
  'members.manage':    { scope: 'team' },
  'agents.create':     { scope: 'team' },
  'agents.administer': { scope: 'team' },
  'connectors.self':   { scope: 'team' },
  'connectors.shared': { scope: 'org' },
  'ops.telemetry':     { scope: 'org' },
  'billing.manage':    { scope: 'team', resolution: 'authority_verdict' }, // §4
} as const)
export type NessieCapability = CapabilityOf<typeof NESSIE_CAPABILITIES>
```

The resolver lives in `uoa-rp-node` (§7) and is constructed once per process
from the same config the product already loads:

```ts
// uoa-rp-node additions
export interface CapabilityDef {
  scope: 'org' | 'team'
  /** 'grant' (default): resolved from role_grants, locally, from signed
   *  material. 'authority_verdict': UOA answers per call/view; the local
   *  resolver REFUSES to answer for it (§4). */
  resolution?: 'grant' | 'authority_verdict'
}
export function defineCapabilities<T extends Record<string, CapabilityDef>>(defs: T): T

export interface CapabilitySet<C extends string> {
  /** True iff the verified role claims, resolved through role_grants, grant
   *  `cap`. Verdict-resolved capabilities are excluded from `C` at the type
   *  level — `has('billing.manage')` is a compile error, not a false answer. */
  has(cap: C): boolean
  /** Display only. Never compare against this — that is the defect this
   *  design retires. */
  roleLabel: string | null
}

interface UoaRp {
  capabilities: {
    /** Resolve for the sealed session's active workspace: the union of the
     *  org-role grants and the active team-role grants (§3 for why union). */
    forWorkspace(ctx: WorkspaceCtx): Promise<CapabilitySet<GrantCapabilityOf<C>>>
  }
}
```

And the gate at a route is one line naming the verb, with the role names
nowhere in sight:

```ts
// nessie api/src/routes/channels.ts — create a channel
const caps = await uoa.capabilities.forWorkspace({ sessionRef })
if (!caps.has('channels.manage')) throw new ForbiddenError('channels.manage')

// nessie api/src/routes/members.ts — change a member's role
if (!caps.has('members.manage')) throw new ForbiddenError('members.manage')
```

For Fastify/Express surfaces, `createUoaRpRouter` gains the obvious
declarative form, so most sites never even call `has`:

```ts
app.post('/api/channels', requireCapability(uoa, 'channels.manage'), handler)
```

The refusal names the capability, not a role: "you need `members.manage` here"
is true under every vocabulary, while "you must be an admin" is already false
the day a domain renames the role.

### 3. Resolution rules — small enough to state completely

Inputs: the verified claims (`org.org_role`, `org.team_roles[activeTeam]` —
exactly what tokens carry today, unchanged) and the signed domain config.
Nothing else. In particular no product-scope table (§5) and no unsigned state.

1. `owner` (org or team) → the full catalogue at that scope, structurally.
2. Otherwise, look the role string up in `role_grants[scope]`. **Missing role,
   missing table, unparseable claim, empty string: empty set.** There is no
   default role, no coercion, no "treat as member". This is `parseRole → null`
   (deep.admin, `directory-client.ts:126-131`) generalized from display to
   authority.
3. The workspace capability set is the **union** of the org-role grants and the
   active-team-role grants. Union, not override: grants only add, and a scope
   with nothing to say adds nothing.
4. An org-scope grant of a team-scope capability means *in every team of the
   org*. This makes "org managers overrule teams" — the refuted proposal's most
   contested doctrine — **a per-domain configuration choice instead of estate
   law**. A domain that wants reach-down grants `members.manage` (team) to its
   org `admin`; a domain that wants strict team autonomy simply doesn't. The
   default config does grant it, preserving UOA's current `isOrgOrTeamManager`
   behaviour.
5. Claims carry **roles, not capabilities**. Considered and rejected: stamping
   resolved capability lists into the token. It bloats every token by
   (teams × catalogue), it freezes grants at mint time so a config change waits
   out the token TTL, and it buys nothing — both inputs to the resolution are
   already signed, so resolving locally is exactly as trustworthy and always
   current. The exception is verdicts (§4), which are UOA-computed precisely
   because their inputs are *not* in the product's hands.

Where enforcement of fail-closed actually sits, so no product can get it wrong:

- **UOA** validates every membership write against the vocabulary (already
  true) and the grant table against the vocabulary and catalogue (new), so an
  un-resolvable role string can never be minted into a claim.
- **`uoa-rp-node`** is the only implementation of steps 1–4, and its
  `WorkspaceMember`/`WorkspaceTeam` role fields become `string | null` display
  labels (an api-spec change — the current `'owner'|'admin'|'member'|'viewer'`
  union bakes yesterday's vocabulary into the contract). The package continues
  to expose **no role predicate of any kind**: you cannot ask it "is this an
  admin", only "may this session do X".
- **`uoa-rp-testkit`** ships a mandatory conformance scenario: a fixture domain
  with a fifth role (`intern`) absent from `role_grants`, and the assertion
  that every gated route in the product answers 403. A product passes the
  conformance suite or it is not on the contract. Non-Node backends (docgen's
  FastAPI) implement steps 1–4 per the `uoa-rp-http` spec and run the same
  fixtures — the suite, not the library, is what is mandatory.
- The product-local mapping functions **are deleted**, not wrapped:
  DeepSignal's `mapRole`, Nessie's `mapUoaMemberRole`, docgen's
  `normalise_role`. Each survives only as far as migration needs it (§8).

### 4. Conditional capabilities — billing, worked end to end

The owner's "unless the billing is outsourced to the parent company" is the
proof that a flat role→capability table is insufficient: whether a team admin
holds `billing.manage` depends on **org state** (`BillingOrgResponsibility`,
shipped in `2026-08-15-org-billing-override.md`), which the product neither
stores nor may compute.

The model therefore has two resolution classes, declared per capability:

- **`grant`** (the default): depends only on config + membership. Resolved
  locally from signed material, deterministic, always current. Everything in §3.
- **`authority_verdict`**: depends on state only UOA holds. UOA answers **in
  the view or call it already owns**, and the local resolver refuses to answer
  at all — `has('billing.manage')` is a compile error, so a product cannot
  accidentally build the local billing gate that water's G1 audit finding
  already showed is wrong.

This is not new machinery. It is the *existing* billing-statement contract —
frozen actions with `enabled`/`disabled_reason`, `controlled_by.can_manage` as
UOA's verdict, "no component composes that sentence" — recognized as the
verdict half of the capability model rather than a billing peculiarity. The
grant table still *mentions* `billing.manage` (a role UOA finds no grant for
gets no billing surface at all); the verdict then decides what the grant is
worth right now.

**The worked example the owner asked for.** Domain config as in §1: team
`admin` is granted `members.manage` and `billing.manage`. Alice is team admin
of team T in org O, with no org-level role beyond `member`.

| Alice's action | Before O assumes billing | After `BillingOrgResponsibility` active |
|---|---|---|
| Change a member's team role | ✅ `members.manage` (grant, local, unchanged) | ✅ identical — the grant never moved |
| Open the team billing statement | ✅ statement with funding actions, `enabled: true` | ✅ statement renders, but `controlled_by` present, actions empty/disabled |
| Start a top-up checkout | ✅ relayed frozen action succeeds | ❌ the action is not offered; a replayed stale one 403s at UOA |
| See why | — | `controlled_by.message`: "Billing for this workspace is managed for the whole organisation." `can_manage: false` |
| Manage org-wide billing | ❌ | ❌ — unless O's billing managers include her, in which case `can_manage: true` and `manage_action_id` name the one next step |

**The product's code is byte-identical in both columns.** It resolves
`members.manage` locally and renders UOA's billing document verbatim; no
branch anywhere asks "is billing org-assumed", so there is nothing to
hard-code and nothing to get stale. That is what "capability conditionally
withdrawn by org state" looks like when the verdict lives with the state.

The same pattern is the named extension point for future conditional grants
(e.g. a compliance hold suspending `content.write` org-wide): add the state to
UOA, flag the capability `authority_verdict`, answer in the owning view. What
is deliberately *not* provided is a generic UOA policy-decision-point endpoint
products call per request — see §7.

### 5. Product scopes stay the product's — same grammar, sealed off

docgen's per-project `viewer<reviewer<editor<admin<owner`, AdGoes' per-platform
`admin|editor|viewer`, Nessie's channel/space roles: these attach to resources
UOA does not model and must not learn (Rule-zero-adjacent: UOA holding a table
of every product's channels is the duplication disease in the other
direction).

They stay product-owned, with two rules:

1. **Reuse the grammar, not the store.** A product-scope role is a binding of
   *product capabilities* to a *product resource*, and products are encouraged
   to express their per-resource checks in the same capability names
   (`content.write` on channel #general), so a screen's gate reads uniformly.
   Vocabulary and storage for these are the product's own.
2. **The seal is structural, not disciplinary.** The §3 resolver's inputs are
   the signed claims and the signed config, and nothing else — a product-scope
   role table physically cannot enter workspace-capability resolution, so a
   docgen project `owner` confers exactly nothing at org or team scope. The
   composed check at a resource is
   `capsFromWorkspace ∪ capsFromResourceMembership(resource)`: workspace
   grants set the baseline a role holds everywhere in scope, resource
   membership adds locally. (Nessie's deny-overrides policy engine remains
   orthogonal and on top, as the refuted doc also correctly left it.)

Uncertainty, stated: whether `role_grants` should be able to reference
*resource-typed* capabilities (e.g. "org `admin` gets docgen `project.admin`
on every project"). Rule 4 of §3 already gives the useful case (org-wide grant
of a team-scope capability); per-resource-type granting adds a third scope
dimension for a case no product has asked for. **Recommendation: not in v1**;
the grant-table shape (`role_grants.<scope>`) extends to a new scope key
without breaking if demand appears.

### 6. Groups — deliberately out of v1

`group_admin[]` is projected into claims today and consumed by **nothing** in
any of the six products (verified by grep across the estate). Groups are also
behind `groups_enabled: false` by default. Designing grants for a tier with
zero consumers would be exactly the speculative generality the house rules
bar.

The exclusion is shaped so it costs nothing later: `role_grants` is keyed by
scope name, so a `"group"` key — with `GroupMember.isAdmin` as a two-value
vocabulary or a configurable one — slots in without touching the resolver's
contract. What v1 *does* do is stop the bleeding: the conformance suite's
unknown-role fixture also asserts that `group_admin` claims grant nothing, so
no product grows an ad-hoc group gate in the meantime.

### 7. The enforcement seam — both, with different jobs, and one reversal

- **UOA** owns: vocabulary validation on membership writes (exists), grant
  table validation (new), verdict capabilities in the views it owns (exists as
  the billing contract), and — new work item — **its own internal gates move
  onto the same table.** `isTeamManager`'s hard-coded `owner|admin` becomes a
  grant lookup (`members.manage` etc. against the domain's `role_grants`,
  default table reproducing today), and `requireTeamManager` is corrected to
  accept team-scope standing, which is the owner's constraint #1: today a team
  owner cannot manage their own team's roster through UOA, and that is a bug
  under this model, not a posture. UOA is a consumer of the model, not an
  exception to it.
- **`uoa-rp-node`** owns: the one resolver (§3), `CapabilitySet`,
  `requireCapability`, and the conformance suite. It remains **not** a network
  PDP — resolution is local and pure, because both inputs are signed documents
  the product already holds. A per-request authorization call to UOA would add
  a availability dependency and latency to every gated route in six products
  and buy precision only for verdict capabilities, which already have a home.

On the deliberate absence of an authority predicate in the current api-spec
("The package exposes no `isManager` helper, deliberately — water's local gate
has no shape to migrate into"): **that decision was right and stands — this
design does not reverse it, it routes around the reason it existed.** The
refusal was aimed at products *re-deriving UOA's view verdicts* (manager-vs-
member projection for billing/roster views) from role claims, which §4 keeps
firmly refused — verdict capabilities are unaskable locally, by type. But
product-functional gates (may this session create a channel?) can never be
UOA view verdicts, because UOA does not know what a channel is; with no
predicate at all, every product hand-rolls `role === 'admin'`, which is
precisely the duplication and inflation catalogued above. `has(capability)` is
therefore added as a different question than the one that was banned:
it answers from the domain's own configuration, names a verb rather than a
rank, and cannot express "is this person an admin" at all.

### 8. Migration — six products, three waves, nothing breaks silently

**Wave 0 — stop the inflation (independent, ships first, behaviour-neutral
today).** DeepSignal `mapRole`, Nessie `mapUoaMemberRole`, docgen
`normalise_role` change unknown → *no role* (deny/absent) instead of
`member`. No live domain currently configures a non-default org role, so this
changes nothing observable — which is exactly why it must land **before** the
first domain does. This is a security fix with its own justification; it does
not wait for the capability model. (Nessie keeps `lead → admin`: that is a
known legacy spelling, not an unknown.)

**Wave 1 — UOA.** `team_roles` config key (mirror of `org_roles`, `owner`
mandatory; `ALLOWED_TEAM_ROLES` becomes the default rather than the law);
`role_grants` + `capabilities` schema with validation; the implied **legacy
default table** when `role_grants` is absent — reproducing today's effective
behaviour (org/team `admin` ≈ manager, `member` ≈ write, plus rule 4's
org-reach-down to match `isOrgOrTeamManager`) — so an untouched domain config
is byte-identical in effect and shipping is inert; UOA's internal gates moved
onto the table; `requireTeamManager` corrected (constraint #1). The corrected
roster gate is the only *observable* change for untouched domains — a team
admin gains the roster authority the owner says they were always meant to
have; it is called out in release notes rather than smuggled.

**Wave 2 — the packages.** `uoa-rp-node` resolver + `requireCapability`;
`uoa-rp-http` spec section for non-Node backends; testkit conformance
including the unknown-role fixture; api-spec amendments (`WorkspaceRole` union
→ display string).

**Wave 3 — products, at their own pace, one surface at a time.** Each product
declares its catalogue, mirrors it into its domain config, and replaces
hard-coded role checks route by route; its local role-mapping function is
deleted when the last caller goes. Order by audit posture, same logic as the
billing rollout: DeepTest and DeepSignal first (smallest, already conformant),
water next (its two-role wish becomes a two-role `team_roles` config), then
Nessie (largest surface; its org-`viewer` finally means what it says, resolved
as a real role with a read-only grant instead of an enum value products
coerce), docgen last (Python implementation against the http spec; its
*project* ladder is untouched throughout, per §5). AdGoes' ad-platform roles
are untouched (§5).

**What breaks, stated plainly:** a domain that configures a custom role
*before* wave 0 reaches its products gets today's inflation — so wave 0 gates
any announcement of the feature. A custom role configured after wave 0 but
before a product's wave 3 adoption is **safe but inert** in that product
(empty capability set, read-nothing member) — honest degradation, the same
shape as the billing protocol's old-client rule. Nothing at any point requires
a coordinated multi-product deploy.

## The matrix — Nessie, action by action

All three reviews of the refuted proposal demanded this artifact. Capability
names from §2; roles from the §1 example config (`auditor` org-scope custom
role, `viewer` team-scope). ✅ = granted by the example table; **structural**
= not role-gated at all today and stays that way.

| Action (route) | Capability | org owner | org admin | org auditor | team admin | team member | team viewer |
|---|---|---|---|---|---|---|---|
| Read channels/messages | `workspace.read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Post, upload (`POST /api/channels/:id/messages`) | `content.write` | ✅ | ✅ | — | ✅ | ✅ | — |
| Create channel (`POST /api/channels`) | `channels.manage` | ✅ | — | — | ✅ | ✅ | — |
| Invite / change member role (`PUT /members/:sub/role`) | `members.manage` | ✅ | ✅ | — | ✅ | — | — |
| Create agent (`POST /api/agents`) | `agents.create` | ✅ | — | — | — | ✅ | — |
| Bind agent / create trigger on another agent | `agents.administer` | ✅ | — | — | ✅ | — | — |
| Install user-scope connector | `connectors.self` | ✅ | — | — | — | ✅ | — |
| Manage shared-scope connectors | `connectors.shared` | ✅ | ✅ | — | — | — | — |
| Read `/ops/usage` telemetry | `ops.telemetry` | ✅ | ✅ | — | — | — | — |
| View `/tokens` credits & statement | (membership) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ — UOA projects manager vs member detail |
| Fund / top-up / cancel (`POST /billing/actions/:id`) | `billing.manage` (verdict) | UOA decides | UOA decides | UOA decides | UOA decides — §4 table | ❌ | ❌ |
| Read own alerts, switch workspace, leave team | structural | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Notes the table encodes: today's Nessie lets *any* member create channels and
agents — the example grant table keeps that for `member` and takes it from
`auditor`/`viewer`, demonstrating a domain choosing differently without a line
of product code; `agents.administer` maps today's owner-only bind/trigger
routes; DeepWater's explicit-grant bundle and the PA's mirrored route
authorizations sit *behind* these gates unchanged — a capability gets you to
the route, the route's deeper invariants stay its own.

## Verification this design owes

- **The unknown-role fixture, everywhere:** a domain config with a role absent
  from `role_grants`, driven through every product's conformance suite; every
  gated route answers 403, every roster renders the role label verbatim.
- **The billing withdrawal example as a test:** assume org responsibility for a
  fixture org; the team admin's member-management routes still 2xx, the
  statement carries `controlled_by`, no funding action is offered, and a
  replayed pre-assumption action 403s at UOA.
- **Legacy-default equivalence:** for a config with no `role_grants`, property-
  test that the resolver's answers equal today's hard-coded predicates
  (`isTeamManager`, `isOrgOrTeamManager`) over all role/scope combinations.
- **Config validation fails loud:** grant table naming an unknown role or
  capability, or granting to `owner`, is rejected at config load with a named
  error, never partially applied.
- **The seal:** a product-scope grant (docgen project owner) resolves zero
  workspace capabilities — asserted in docgen's suite once it adopts.

## Open questions, with recommendations

1. **Cross-product workspace mappings.** An org belongs to one domain
   (`Organisation.domain`); product-workspace mappings can surface it in
   another product, whose grant table may not mention the originating
   vocabulary. Fail-closed makes this *safe* (unknown role = nothing) but
   possibly *surprising* (a mapped org's admins arrive powerless).
   **Recommendation:** UOA warns at mapping-creation time when the two domains'
   vocabularies diverge, and the receiving domain's config may alias
   (`role_aliases: {"admin": "admin"}` is implicit; only divergent names need
   stating). Decide when the first cross-product mapping with a custom
   vocabulary actually appears.
2. **Per-team grant overrides** ("this one team's `member` may not write").
   Deliberately excluded: it turns the grant table into a per-team policy
   store, which is what product policy engines (Nessie's deny-overrides) are
   for. Revisit only with a concrete customer case.
3. **Whether `capabilities` mirrors drift.** The catalogue lives in code and is
   mirrored into config for validation; the two can drift (config lists a verb
   the code no longer checks). **Recommendation:** each product's lint gate
   asserts config ⊆ code catalogue, the same shape as the billing protocol's
   SHA manifest gate.

## What this supersedes

`2026-08-16-estate-role-model.md` stays in place as the refutation record; its
banner now points here. Of its content, three things survive into this design:
the confirmation that no team-scoped super-admin exists anywhere in the estate;
the rule that product-scope roles never confer org/team authority (§5 makes it
structural rather than disciplinary); and the observation that Nessie's policy
engine is orthogonal. Its three-tier ladder, the superuser mirror, and
"org managers overrule teams" as doctrine are all dead — the last one
resurrected only as a per-domain configuration choice (§3 rule 4), which is
where a question with two defensible answers belongs.
