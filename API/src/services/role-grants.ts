/**
 * Per-domain role → capability grants.
 *
 * Spec: `Docs/plans/2026-08-16-configurable-roles-and-capabilities.md` (wave 1, §1/§3/§7).
 *
 * The domain owns the role *vocabulary* (`org_roles`, `team_roles`) and the *binding* of roles to
 * capability names (`role_grants`); the product owns the capability names themselves, declared in
 * code. UOA is a consumer of that model rather than an exception to it: its own gates resolve a
 * capability instead of comparing a role string, so a role a domain invented can hold real
 * authority inside the authority.
 *
 * Three rules make the resolution small enough to state completely:
 *
 *  1. `owner` (org or team) implicitly holds every capability at the scope it stands in. That is
 *     structural, never configured — which is why `owner` is barred from the grant table: a domain
 *     must not be able to write a config that locks its own recovery role out.
 *  2. Any other role is looked up in `role_grants[scope]`. A missing role, a missing table entry,
 *     an unknown string: the empty set. There is no coercion and no default role.
 *  3. A workspace answer is the UNION of the org-role grants and the team-role grants. Union, not
 *     override — a scope with nothing to say adds nothing. An org-scope grant of a team-scope
 *     capability therefore means "in every team of the org", which is how the legacy default table
 *     reproduces today's org-manager reach-down.
 *
 * This module is pure: no Prisma, no config parsing. `team.service.base.ts` supplies the
 * membership lookups, `config-org-features.schema.ts` supplies the validation.
 */

/**
 * The capability names UOA's own gates check. Closed set, declared in code — a capability nobody's
 * code checks is a lie, so this list only grows when a real gate starts asking for one.
 *
 *  - `members.manage` — mutate a workspace roster: add/remove members, change a member's team role,
 *    create/revoke invitations and invite links, and read the PII-bearing invited list.
 *  - `teams.manage` — the team object itself: create, rename, re-slug, change join policy or icon,
 *    delete.
 *
 * A domain's `org_features.capabilities` declares its *product's* catalogue on top of these; the
 * names below are always valid in a grant table because UOA compiled them in.
 */
export const UOA_CAPABILITIES = ['members.manage', 'teams.manage'] as const;

export type UoaCapability = (typeof UOA_CAPABILITIES)[number];

/** The one fixed role: mandatory in every vocabulary, implicitly every capability, never granted. */
export const OWNER_ROLE = 'owner';

export const DEFAULT_ORG_ROLES: readonly string[] = ['owner', 'admin', 'member'];
export const DEFAULT_TEAM_ROLES: readonly string[] = ['owner', 'admin', 'member'];

export const ROLE_GRANT_SCOPES = ['org', 'team'] as const;
export type RoleGrantScope = (typeof ROLE_GRANT_SCOPES)[number];

/** role name → capability names, per scope. Absent scope or absent role means "no capabilities". */
export type RoleGrantTable = {
  [scope in RoleGrantScope]?: Record<string, string[]>;
};

/**
 * What a domain gets when it has not written a `role_grants` table — i.e. every domain today.
 *
 * It reproduces the effective behaviour of the predicates it replaces (`isTeamManager`,
 * `isOrgOrTeamManager`) exactly: `admin` is a manager at both scopes, every other non-owner role
 * holds nothing, and because the ORG entry grants team-scope capabilities the org-manager
 * reach-down survives (§3 rule 4). Shipping this wave is therefore inert for an untouched config
 * apart from the one deliberate correction in `requireWorkspaceCapability`'s call sites — a team
 * owner/admin now has standing over their own team, which `requireTeamManager` used to ignore.
 */
export const LEGACY_DEFAULT_ROLE_GRANTS: RoleGrantTable = Object.freeze({
  org: Object.freeze({ admin: [...UOA_CAPABILITIES] }),
  team: Object.freeze({ admin: [...UOA_CAPABILITIES] }),
}) as RoleGrantTable;

/**
 * The shape this module needs out of a verified client config. Declared structurally rather than
 * imported so `config.service.ts` can depend on the validation that depends on this file without a
 * cycle; `ClientConfig` satisfies it.
 */
export type RoleGrantsConfig = {
  org_features?: {
    org_roles?: string[];
    team_roles?: string[];
    capabilities?: string[];
    role_grants?: RoleGrantTable;
  };
};

function withOwner(roles: string[] | undefined, fallback: readonly string[]): string[] {
  return roles && roles.length > 0 ? roles : [...fallback];
}

/** The domain's org-role vocabulary. `org_roles` has always been configurable; this is its reader. */
export function resolveOrgRoleVocabulary(config: RoleGrantsConfig): string[] {
  return withOwner(config.org_features?.org_roles, DEFAULT_ORG_ROLES);
}

/**
 * The domain's team-role vocabulary. New in this wave: `owner|admin|member` used to be the law
 * (`ALLOWED_TEAM_ROLES`), and is now only the default.
 */
export function resolveTeamRoleVocabulary(config: RoleGrantsConfig): string[] {
  return withOwner(config.org_features?.team_roles, DEFAULT_TEAM_ROLES);
}

export function resolveRoleVocabulary(config: RoleGrantsConfig, scope: RoleGrantScope): string[] {
  return scope === 'org' ? resolveOrgRoleVocabulary(config) : resolveTeamRoleVocabulary(config);
}

/** The domain's grant table, or the legacy default when it configured none. */
export function resolveRoleGrants(config: RoleGrantsConfig): RoleGrantTable {
  return config.org_features?.role_grants ?? LEGACY_DEFAULT_ROLE_GRANTS;
}

/**
 * Every capability name a grant table may legally reference for this domain: UOA's own catalogue
 * plus whatever the product declared. Used by config validation, so a table naming a verb nobody
 * implements is rejected at write time instead of failing open at request time.
 */
export function resolveKnownCapabilities(config: RoleGrantsConfig): Set<string> {
  return new Set<string>([...UOA_CAPABILITIES, ...(config.org_features?.capabilities ?? [])]);
}

/**
 * §3 rules 1 and 2, for ONE role at ONE scope. `owner` short-circuits; everything else is a set
 * membership test against the table, with absence meaning the empty set.
 */
export function roleHoldsCapability(
  grants: RoleGrantTable,
  scope: RoleGrantScope,
  role: string | null | undefined,
  capability: string,
): boolean {
  const normalized = role?.trim();
  if (!normalized) return false;
  if (normalized === OWNER_ROLE) return true;
  return grants[scope]?.[normalized]?.includes(capability) === true;
}

/** `roleHoldsCapability` against the domain's resolved table — the common one-shot form. */
export function configRoleHoldsCapability(
  config: RoleGrantsConfig,
  scope: RoleGrantScope,
  role: string | null | undefined,
  capability: string,
): boolean {
  return roleHoldsCapability(resolveRoleGrants(config), scope, role, capability);
}

/**
 * §3 rule 3: the workspace answer is the union of the two scopes. Passing `teamRole: null` is the
 * honest shape for an action that has no team to stand in yet (creating one), where only org-scope
 * grants can authorise.
 */
export function workspaceRolesHoldCapability(
  grants: RoleGrantTable,
  roles: { orgRole?: string | null; teamRole?: string | null },
  capability: string,
): boolean {
  return (
    roleHoldsCapability(grants, 'org', roles.orgRole, capability) ||
    roleHoldsCapability(grants, 'team', roles.teamRole, capability)
  );
}
