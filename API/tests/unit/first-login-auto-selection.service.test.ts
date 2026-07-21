import { describe, expect, it } from 'vitest';

import {
  resolveAutoSelectedWorkspace,
  shouldPresentWorkspaceChooser,
  type WorkspaceChoices,
} from '../../src/services/first-login.service.js';

describe('resolveAutoSelectedWorkspace', () => {
  const soloTeam = {
    teamId: 'team-1',
    orgId: 'org-1',
    name: 'Solo',
    role: 'owner',
    iconUrl: null,
    slug: 'solo',
  };

  function choices(overrides?: Partial<WorkspaceChoices>): WorkspaceChoices {
    return {
      teams: [soloTeam],
      pending_invites: [],
      can_create_org: false,
      ...overrides,
    };
  }

  it('returns the exact org/team for one ACTIVE team with no pending invites', () => {
    expect(resolveAutoSelectedWorkspace(choices())).toEqual({
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('does not select when there are multiple teams, a pending invite, or no team', () => {
    expect(
      resolveAutoSelectedWorkspace(
        choices({
          teams: [soloTeam, { ...soloTeam, teamId: 'team-2', name: 'Second', slug: 'second' }],
        }),
      ),
    ).toBeNull();
    expect(
      resolveAutoSelectedWorkspace(
        choices({
          pending_invites: [{ inviteId: 'invite-1', teamName: 'Invited', invitedBy: 'Alice' }],
        }),
      ),
    ).toBeNull();
    expect(resolveAutoSelectedWorkspace(choices({ teams: [] }))).toBeNull();
  });

  it('presents the chooser for ambiguous choices and the empty create-workspace entrypoint', () => {
    expect(
      shouldPresentWorkspaceChooser(
        choices({
          teams: [soloTeam, { ...soloTeam, teamId: 'team-2', name: 'Second', slug: 'second' }],
        }),
      ),
    ).toBe(true);
    expect(
      shouldPresentWorkspaceChooser(
        choices({
          pending_invites: [{ inviteId: 'invite-1', teamName: 'Invited', invitedBy: 'Alice' }],
        }),
      ),
    ).toBe(true);
    expect(shouldPresentWorkspaceChooser(choices({ teams: [], can_create_org: true }))).toBe(true);
    expect(shouldPresentWorkspaceChooser(choices())).toBe(false);
    expect(shouldPresentWorkspaceChooser(choices({ teams: [], can_create_org: false }))).toBe(
      false,
    );
  });
});
