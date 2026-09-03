import { describe, expect, it } from 'vitest';

import {
  resolveAutoSelectedTeam,
  shouldPresentTeamChooser,
  type SessionChoices,
} from '../../src/services/first-login.service.js';

describe('resolveAutoSelectedTeam', () => {
  const soloTeam = {
    teamId: 'team-1',
    orgId: 'org-1',
    name: 'Solo',
    role: 'owner',
    iconUrl: null,
    slug: 'solo',
  };

  function choices(overrides?: Partial<SessionChoices>): SessionChoices {
    return {
      teams: [soloTeam],
      pending_invites: [],
      can_create_org: false,
      ...overrides,
    };
  }

  it('returns the exact org/team for one ACTIVE team with no pending invites', () => {
    expect(resolveAutoSelectedTeam(choices())).toEqual({
      orgId: 'org-1',
      teamId: 'team-1',
    });
  });

  it('does not select when there are multiple teams, a pending invite, or no team', () => {
    expect(
      resolveAutoSelectedTeam(
        choices({
          teams: [soloTeam, { ...soloTeam, teamId: 'team-2', name: 'Second', slug: 'second' }],
        }),
      ),
    ).toBeNull();
    expect(
      resolveAutoSelectedTeam(
        choices({
          pending_invites: [{ inviteId: 'invite-1', teamName: 'Invited', invitedBy: 'Alice' }],
        }),
      ),
    ).toBeNull();
    expect(resolveAutoSelectedTeam(choices({ teams: [] }))).toBeNull();
  });

  it('presents the chooser for ambiguous choices and the empty create-team entrypoint', () => {
    expect(
      shouldPresentTeamChooser(
        choices({
          teams: [soloTeam, { ...soloTeam, teamId: 'team-2', name: 'Second', slug: 'second' }],
        }),
      ),
    ).toBe(true);
    expect(
      shouldPresentTeamChooser(
        choices({
          pending_invites: [{ inviteId: 'invite-1', teamName: 'Invited', invitedBy: 'Alice' }],
        }),
      ),
    ).toBe(true);
    expect(shouldPresentTeamChooser(choices({ teams: [], can_create_org: true }))).toBe(true);
    expect(shouldPresentTeamChooser(choices())).toBe(false);
    expect(shouldPresentTeamChooser(choices({ teams: [], can_create_org: false }))).toBe(
      false,
    );
  });
});
