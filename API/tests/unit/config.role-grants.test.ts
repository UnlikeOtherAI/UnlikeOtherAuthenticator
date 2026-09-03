import { describe, expect, it } from 'vitest';
import type { JWTPayload } from 'jose';

import { validateConfigFields } from '../../src/services/config.service.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';

/**
 * Config validation for the wave-1 additions (`team_roles`, `capabilities`, `role_grants`).
 *
 * A grant table naming a role or a verb nobody implements must be rejected at write time. Failing
 * open at request time is the exact defect this design exists to retire, so every rejection below
 * is a hard parse failure — never a partially applied config.
 */

function payload(orgFeatures: Record<string, unknown>): JWTPayload {
  return baseClientConfigPayload({ org_features: { enabled: true, ...orgFeatures } });
}

describe('config: team_roles', () => {
  it('defaults to the three canonical roles when absent', () => {
    const cfg = validateConfigFields(payload({}));
    expect(cfg.org_features?.team_roles).toEqual(['owner', 'admin', 'member']);
  });

  it('accepts a domain-authored vocabulary', () => {
    const cfg = validateConfigFields(payload({ team_roles: ['owner', 'editor', 'viewer'] }));
    expect(cfg.org_features?.team_roles).toEqual(['owner', 'editor', 'viewer']);
  });

  it('rejects a vocabulary without "owner", exactly as org_roles does', () => {
    expect(() => validateConfigFields(payload({ team_roles: ['admin', 'member'] }))).toThrow();
    expect(() => validateConfigFields(payload({ org_roles: ['admin', 'member'] }))).toThrow();
  });

  it('rejects an empty role name and one over 50 characters', () => {
    expect(() => validateConfigFields(payload({ team_roles: ['owner', ''] }))).toThrow();
    expect(() => validateConfigFields(payload({ team_roles: ['owner', 'x'.repeat(51)] }))).toThrow();
  });
});

describe('config: role_grants validation', () => {
  it('accepts a table that names only configured roles and declared capabilities', () => {
    const cfg = validateConfigFields(
      payload({
        org_roles: ['owner', 'admin', 'auditor'],
        team_roles: ['owner', 'editor', 'viewer'],
        capabilities: ['team.read', 'content.write'],
        role_grants: {
          org: { auditor: ['team.read'], admin: ['members.manage'] },
          team: { editor: ['members.manage', 'content.write'], viewer: [] },
        },
      }),
    );

    expect(cfg.org_features?.role_grants?.team?.editor).toEqual([
      'members.manage',
      'content.write',
    ]);
  });

  it('accepts UOA capability names without the domain having to declare them', () => {
    const cfg = validateConfigFields(
      payload({ role_grants: { team: { member: ['members.manage', 'teams.manage'] } } }),
    );
    expect(cfg.org_features?.role_grants?.team?.member).toEqual([
      'members.manage',
      'teams.manage',
    ]);
  });

  it('rejects a grant to a role outside the org vocabulary', () => {
    expect(() =>
      validateConfigFields(
        payload({ org_roles: ['owner', 'admin'], role_grants: { org: { auditor: [] } } }),
      ),
    ).toThrow(/not in org_roles/);
  });

  it('rejects a grant to a role outside the team vocabulary', () => {
    expect(() =>
      validateConfigFields(
        payload({ team_roles: ['owner', 'member'], role_grants: { team: { editor: [] } } }),
      ),
    ).toThrow(/not in team_roles/);
  });

  it('rejects an undeclared capability name', () => {
    expect(() =>
      validateConfigFields(
        payload({
          capabilities: ['team.read'],
          role_grants: { org: { admin: ['team.read', 'billing.manage'] } },
        }),
      ),
    ).toThrow(/undeclared capability .{1,2}billing\.manage/);
  });

  it('rejects any grant to "owner", at either scope', () => {
    expect(() =>
      validateConfigFields(payload({ role_grants: { org: { owner: ['members.manage'] } } })),
    ).toThrow(/must not name .{1,2}owner/);
    expect(() =>
      validateConfigFields(payload({ role_grants: { team: { owner: [] } } })),
    ).toThrow(/must not name .{1,2}owner/);
  });

  it('rejects an unknown scope key rather than silently ignoring it', () => {
    expect(() =>
      validateConfigFields(payload({ role_grants: { group: { admin: ['members.manage'] } } })),
    ).toThrow();
  });

  it('applies nothing when it rejects — the whole config fails', () => {
    // A partially applied grant table would be worse than none: half a config is an authorization
    // decision nobody wrote.
    expect(() =>
      validateConfigFields(
        payload({
          role_grants: {
            org: { admin: ['members.manage'] },
            team: { nonexistent: ['members.manage'] },
          },
        }),
      ),
    ).toThrow();
  });

  it('leaves role_grants absent when the domain wrote none', () => {
    const cfg = validateConfigFields(payload({}));
    expect(cfg.org_features?.role_grants).toBeUndefined();
    expect(cfg.org_features?.capabilities).toBeUndefined();
  });
});
