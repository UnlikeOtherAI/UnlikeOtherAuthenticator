import { describe, expect, it } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import {
  LEGACY_DEFAULT_ROLE_GRANTS,
  UOA_CAPABILITIES,
  configRoleHoldsCapability,
  resolveKnownCapabilities,
  resolveRoleGrants,
  resolveTeamRoleVocabulary,
  roleHoldsCapability,
  teamRolesHoldCapability,
  type RoleGrantScope,
  type RoleGrantTable,
  type UoaCapability,
} from '../../src/services/role-grants.js';

/**
 * Wave 1 of `Docs/plans/2026-08-16-configurable-roles-and-capabilities.md`, plus the org-scope
 * follow-up that added `organisation.manage`.
 *
 * The load-bearing test here is `legacy-default equivalence`: with no `role_grants` in the config —
 * i.e. every domain that exists today — the resolver must answer exactly what the hard-coded
 * predicates it replaced answered. That is the property that makes shipping this inert, so it is
 * asserted exhaustively over every role × scope × capability rather than sampled.
 */

function config(orgFeatures?: Partial<NonNullable<ClientConfig['org_features']>>): ClientConfig {
  return { org_features: orgFeatures } as unknown as ClientConfig;
}

/** The predicate this wave replaces, verbatim from `team.service.base.ts` before the change. */
function legacyIsTeamManager(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * The pre-change answer for one (scope, capability, role), across every predicate this model
 * replaced: `isTeamManager` / `isOrgOrTeamManager` (team surfaces), and `requireOrgManagerActor`
 * plus the inline `role !== 'owner' && role !== 'admin'` comparisons in the three org services.
 *
 * They were the same comparison, so the only per-capability distinction is a scope one:
 * `organisation.manage` gates ORG-scope surfaces (rename, invite policy, icon) whose gates never
 * read a `TeamMember` row at all, so at team scope nothing but the structural `owner` holds it.
 */
function legacyHolds(scope: RoleGrantScope, capability: UoaCapability, role: string): boolean {
  if (capability === 'organisation.manage' && scope === 'team') return role === 'owner';
  return legacyIsTeamManager(role);
}

const ALL_ROLES = ['owner', 'admin', 'member', 'viewer', 'auditor', 'intern', '', 'Admin', 'OWNER'];
const SCOPES: RoleGrantScope[] = ['org', 'team'];

describe('role grants: legacy-default equivalence', () => {
  const noGrants = config();

  it('falls back to the legacy default table when the domain configured none', () => {
    expect(resolveRoleGrants(noGrants)).toBe(LEGACY_DEFAULT_ROLE_GRANTS);
    expect(resolveRoleGrants(config({}))).toBe(LEGACY_DEFAULT_ROLE_GRANTS);
  });

  it('answers exactly the predicate it replaced for every role × scope × capability', () => {
    for (const scope of SCOPES) {
      for (const role of ALL_ROLES) {
        for (const capability of UOA_CAPABILITIES) {
          expect(
            configRoleHoldsCapability(noGrants, scope, role, capability),
            `${scope}/${role}/${capability}`,
          ).toBe(legacyHolds(scope, capability, role));
        }
      }
    }
  });

  it('reproduces `isOrgOrTeamManager` (org role OR team role) for every combination', () => {
    const grants = resolveRoleGrants(noGrants);

    for (const orgRole of ALL_ROLES) {
      for (const teamRole of ALL_ROLES) {
        for (const capability of UOA_CAPABILITIES) {
          expect(
            teamRolesHoldCapability(grants, { orgRole, teamRole }, capability),
            `${orgRole}+${teamRole}/${capability}`,
          ).toBe(legacyHolds('org', capability, orgRole) || legacyHolds('team', capability, teamRole));
        }
      }
    }
  });

  it('keeps `organisation.manage` out of team scope: a team admin cannot rename the org', () => {
    // Not a detail of the default table but the shape of the capability: the org gates pass no team
    // standing at all, and administering one team must not confer authority over the tenant that
    // contains it. Only the structural `owner` answers true at team scope.
    expect(configRoleHoldsCapability(noGrants, 'org', 'admin', 'organisation.manage')).toBe(true);
    expect(configRoleHoldsCapability(noGrants, 'team', 'admin', 'organisation.manage')).toBe(false);
    expect(configRoleHoldsCapability(noGrants, 'team', 'owner', 'organisation.manage')).toBe(true);
  });

  it('keeps the org-manager reach-down: an org grant covers team-scope capabilities', () => {
    // §3 rule 4 — an org-scope grant of a team-scope capability means "in every team of the org",
    // which is what `requireTeamManager`'s org-only check used to encode.
    const grants = resolveRoleGrants(noGrants);
    expect(
      teamRolesHoldCapability(grants, { orgRole: 'admin', teamRole: null }, 'members.manage'),
    ).toBe(true);
    expect(
      teamRolesHoldCapability(grants, { orgRole: 'member', teamRole: null }, 'members.manage'),
    ).toBe(false);
  });

  it('defaults the team-role vocabulary to the three canonical roles', () => {
    expect(resolveTeamRoleVocabulary(noGrants)).toEqual(['owner', 'admin', 'member']);
    expect(resolveTeamRoleVocabulary(config({ team_roles: ['owner', 'editor'] }))).toEqual([
      'owner',
      'editor',
    ]);
  });
});

describe('role grants: owner is fixed', () => {
  it('holds every capability at every scope even when the table is empty', () => {
    const locked = config({ role_grants: { org: {}, team: {} } });

    for (const scope of SCOPES) {
      for (const capability of UOA_CAPABILITIES) {
        expect(configRoleHoldsCapability(locked, scope, 'owner', capability)).toBe(true);
      }
    }
  });

  it('holds capabilities a config never declared at all', () => {
    // The catalogue is the product's, and owner is defined as "all of it" — not as "everything the
    // table happens to mention".
    expect(configRoleHoldsCapability(config(), 'team', 'owner', 'billing.manage')).toBe(true);
  });

  it('matches byte-exact: "Owner" and " owner " are different, ungranted roles', () => {
    // Normalising here could only widen — a stored string matching a grant it is not.
    expect(configRoleHoldsCapability(config(), 'org', 'Owner', 'members.manage')).toBe(false);
    expect(configRoleHoldsCapability(config(), 'org', ' owner ', 'members.manage')).toBe(false);
    expect(configRoleHoldsCapability(config(), 'org', ' admin', 'members.manage')).toBe(false);
  });
});

describe('role grants: a configured table', () => {
  const custom: RoleGrantTable = {
    org: { auditor: ['team.read'], admin: ['members.manage'] },
    team: { editor: ['members.manage', 'content.write'], viewer: ['team.read'] },
  };
  const customConfig = config({
    org_roles: ['owner', 'admin', 'auditor'],
    team_roles: ['owner', 'editor', 'viewer'],
    capabilities: ['team.read', 'content.write'],
    role_grants: custom,
  });

  it('grants a custom role exactly the capabilities the domain listed', () => {
    expect(configRoleHoldsCapability(customConfig, 'team', 'editor', 'members.manage')).toBe(true);
    expect(configRoleHoldsCapability(customConfig, 'team', 'editor', 'content.write')).toBe(true);
    expect(configRoleHoldsCapability(customConfig, 'team', 'editor', 'teams.manage')).toBe(false);
  });

  it('gives a role the table does not mention the empty set, not a floor', () => {
    // The unknown-role fixture the spec's conformance section demands: `intern` is nowhere in the
    // table, so it can do nothing — never coerced to `member`.
    for (const scope of SCOPES) {
      for (const capability of [...UOA_CAPABILITIES, 'team.read']) {
        expect(configRoleHoldsCapability(customConfig, scope, 'intern', capability)).toBe(false);
      }
    }
    expect(configRoleHoldsCapability(customConfig, 'team', 'viewer', 'members.manage')).toBe(false);
  });

  it('replaces the legacy default rather than merging with it', () => {
    // The configured table grants org `admin` only `members.manage`; `teams.manage` — which the
    // legacy default would have given it — is gone.
    expect(configRoleHoldsCapability(customConfig, 'org', 'admin', 'members.manage')).toBe(true);
    expect(configRoleHoldsCapability(customConfig, 'org', 'admin', 'teams.manage')).toBe(false);
  });

  it('unions the two scopes rather than letting either override', () => {
    const grants = resolveRoleGrants(customConfig);
    expect(
      teamRolesHoldCapability(grants, { orgRole: 'auditor', teamRole: 'editor' }, 'members.manage'),
    ).toBe(true);
    expect(
      teamRolesHoldCapability(grants, { orgRole: 'auditor', teamRole: 'viewer' }, 'members.manage'),
    ).toBe(false);
    expect(
      teamRolesHoldCapability(grants, { orgRole: 'auditor', teamRole: 'viewer' }, 'team.read'),
    ).toBe(true);
  });

  it('treats a missing scope key as the empty set', () => {
    const orgOnly = config({ role_grants: { org: { admin: ['members.manage'] } } });
    expect(configRoleHoldsCapability(orgOnly, 'team', 'admin', 'members.manage')).toBe(false);
    expect(roleHoldsCapability({}, 'team', 'admin', 'members.manage')).toBe(false);
  });

  it('counts UOA capabilities as known on top of whatever the product declared', () => {
    expect([...resolveKnownCapabilities(customConfig)].sort()).toEqual([
      'content.write',
      'members.manage',
      // Lexicographic: '.' (0x2E) sorts before 's' (0x73), so 'team.read' precedes 'teams.manage'.
      'organisation.manage',
      'team.read',
      'teams.manage',
    ]);
    expect([...resolveKnownCapabilities(config())].sort()).toEqual([
      'members.manage',
      'organisation.manage',
      'teams.manage',
    ]);
  });
});
