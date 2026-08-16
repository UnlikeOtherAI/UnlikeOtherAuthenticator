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
  workspaceRolesHoldCapability,
  type RoleGrantScope,
  type RoleGrantTable,
} from '../../src/services/role-grants.js';

/**
 * Wave 1 of `Docs/plans/2026-08-16-configurable-roles-and-capabilities.md`.
 *
 * The load-bearing test here is `legacy-default equivalence`: with no `role_grants` in the config —
 * i.e. every domain that exists today — the resolver must answer exactly what the hard-coded
 * predicates it replaced answered. That is the property that makes shipping this inert, so it is
 * asserted exhaustively over every role/scope pair rather than sampled.
 */

function config(orgFeatures?: Partial<NonNullable<ClientConfig['org_features']>>): ClientConfig {
  return { org_features: orgFeatures } as unknown as ClientConfig;
}

/** The predicate this wave replaces, verbatim from `team.service.base.ts` before the change. */
function legacyIsTeamManager(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

const ALL_ROLES = ['owner', 'admin', 'member', 'viewer', 'auditor', 'intern', '', 'Admin', 'OWNER'];
const SCOPES: RoleGrantScope[] = ['org', 'team'];

describe('role grants: legacy-default equivalence', () => {
  const noGrants = config();

  it('falls back to the legacy default table when the domain configured none', () => {
    expect(resolveRoleGrants(noGrants)).toBe(LEGACY_DEFAULT_ROLE_GRANTS);
    expect(resolveRoleGrants(config({}))).toBe(LEGACY_DEFAULT_ROLE_GRANTS);
  });

  it('answers exactly `isTeamManager` for every role at every scope and capability', () => {
    for (const scope of SCOPES) {
      for (const role of ALL_ROLES) {
        for (const capability of UOA_CAPABILITIES) {
          expect(
            configRoleHoldsCapability(noGrants, scope, role, capability),
            `${scope}/${role}/${capability}`,
          ).toBe(legacyIsTeamManager(role));
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
            workspaceRolesHoldCapability(grants, { orgRole, teamRole }, capability),
            `${orgRole}+${teamRole}/${capability}`,
          ).toBe(legacyIsTeamManager(orgRole) || legacyIsTeamManager(teamRole));
        }
      }
    }
  });

  it('keeps the org-manager reach-down: an org grant covers team-scope capabilities', () => {
    // §3 rule 4 — an org-scope grant of a team-scope capability means "in every team of the org",
    // which is what `requireTeamManager`'s org-only check used to encode.
    const grants = resolveRoleGrants(noGrants);
    expect(
      workspaceRolesHoldCapability(grants, { orgRole: 'admin', teamRole: null }, 'members.manage'),
    ).toBe(true);
    expect(
      workspaceRolesHoldCapability(grants, { orgRole: 'member', teamRole: null }, 'members.manage'),
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
    org: { auditor: ['workspace.read'], admin: ['members.manage'] },
    team: { editor: ['members.manage', 'content.write'], viewer: ['workspace.read'] },
  };
  const customConfig = config({
    org_roles: ['owner', 'admin', 'auditor'],
    team_roles: ['owner', 'editor', 'viewer'],
    capabilities: ['workspace.read', 'content.write'],
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
      for (const capability of [...UOA_CAPABILITIES, 'workspace.read']) {
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
      workspaceRolesHoldCapability(grants, { orgRole: 'auditor', teamRole: 'editor' }, 'members.manage'),
    ).toBe(true);
    expect(
      workspaceRolesHoldCapability(grants, { orgRole: 'auditor', teamRole: 'viewer' }, 'members.manage'),
    ).toBe(false);
    expect(
      workspaceRolesHoldCapability(grants, { orgRole: 'auditor', teamRole: 'viewer' }, 'workspace.read'),
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
      'teams.manage',
      'workspace.read',
    ]);
    expect([...resolveKnownCapabilities(config())].sort()).toEqual([
      'members.manage',
      'teams.manage',
    ]);
  });
});
