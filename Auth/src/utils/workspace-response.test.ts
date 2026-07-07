import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceChoices } from '../hooks/use-popup.js';
import {
  applyWorkspaceOutcome,
  interpretWorkspaceResponse,
  pickAutoSkipTeam,
  toWorkspaceChoices,
} from './workspace-response.js';

const TEAM_A = { teamId: 'team-a', orgId: 'org-a', name: 'Backend Team', role: 'member' };
const INVITE_A = { inviteId: 'invite-a', teamName: 'Growth', invitedBy: 'Jo' };

describe('interpretWorkspaceResponse', () => {
  it('decodes a workspace chooser payload (no `ok` field)', () => {
    const outcome = interpretWorkspaceResponse({
      login_token: 'bridge.jwt',
      teams: [TEAM_A],
      pending_invites: [INVITE_A],
      can_create_org: true,
    });

    expect(outcome).toEqual({
      kind: 'chooser',
      loginToken: 'bridge.jwt',
      choices: {
        teams: [TEAM_A],
        pending_invites: [INVITE_A],
        can_create_org: true,
      },
    });
  });

  it('drops malformed entries out of teams/pending_invites rather than throwing', () => {
    const outcome = interpretWorkspaceResponse({
      login_token: 'bridge.jwt',
      teams: [TEAM_A, { teamId: 'missing-fields' }],
      pending_invites: [INVITE_A, { inviteId: 'no-team-name' }, 'not-an-object'],
      can_create_org: false,
    });

    expect(outcome.kind).toBe('chooser');
    if (outcome.kind === 'chooser') {
      expect(outcome.choices.teams).toEqual([TEAM_A]);
      expect(outcome.choices.pending_invites).toEqual([INVITE_A]);
    }
  });

  it('decodes a 2FA challenge', () => {
    const outcome = interpretWorkspaceResponse({ ok: true, twofa_required: true, twofa_token: 'tok' });
    expect(outcome).toEqual({ kind: 'twofa', token: 'tok' });
  });

  it('decodes a forced 2FA enrollment', () => {
    const outcome = interpretWorkspaceResponse({
      ok: true,
      twofa_enroll_required: true,
      setup_token: 'setup.jwt',
      otpauth_uri: 'otpauth://totp/x',
    });
    expect(outcome).toEqual({
      kind: 'twofa_enroll',
      setup: {
        setup_token: 'setup.jwt',
        otpauth_uri: 'otpauth://totp/x',
        qr_svg: undefined,
        manual_secret: undefined,
      },
    });
  });

  it('decodes a final redirect', () => {
    const outcome = interpretWorkspaceResponse({ ok: true, redirect_to: 'https://client.example/cb' });
    expect(outcome).toEqual({ kind: 'redirect', url: 'https://client.example/cb' });
  });

  it('falls back to a generic error for an unrecognized or missing response', () => {
    expect(interpretWorkspaceResponse(null)).toEqual({ kind: 'error' });
    expect(interpretWorkspaceResponse({ ok: true })).toEqual({ kind: 'error' });
    expect(interpretWorkspaceResponse('not-an-object')).toEqual({ kind: 'error' });
  });
});

describe('toWorkspaceChoices', () => {
  it('decodes a bare /auth/session-choices payload (no login_token field)', () => {
    const choices = toWorkspaceChoices({
      teams: [TEAM_A],
      pending_invites: [INVITE_A],
      can_create_org: true,
    });

    expect(choices).toEqual({
      teams: [TEAM_A],
      pending_invites: [INVITE_A],
      can_create_org: true,
    });
  });

  it('drops malformed entries rather than throwing', () => {
    const choices = toWorkspaceChoices({
      teams: [TEAM_A, { teamId: 'missing-fields' }],
      pending_invites: ['not-an-object'],
      can_create_org: false,
    });

    expect(choices?.teams).toEqual([TEAM_A]);
    expect(choices?.pending_invites).toEqual([]);
  });

  it('returns null for anything that is not a valid chooser payload', () => {
    expect(toWorkspaceChoices(null)).toBeNull();
    expect(toWorkspaceChoices({ can_create_org: true })).toBeNull();
    expect(toWorkspaceChoices('not-an-object')).toBeNull();
  });
});

describe('pickAutoSkipTeam', () => {
  it('picks the sole team when there is exactly one team and no invites', () => {
    const choices: WorkspaceChoices = { teams: [TEAM_A], pending_invites: [], can_create_org: false };
    expect(pickAutoSkipTeam(choices)).toEqual(TEAM_A);
  });

  it('does not skip when there is a pending invite alongside the one team', () => {
    const choices: WorkspaceChoices = {
      teams: [TEAM_A],
      pending_invites: [INVITE_A],
      can_create_org: false,
    };
    expect(pickAutoSkipTeam(choices)).toBeNull();
  });

  it('does not skip with zero or multiple teams', () => {
    expect(pickAutoSkipTeam({ teams: [], pending_invites: [], can_create_org: true })).toBeNull();
    expect(
      pickAutoSkipTeam({
        teams: [TEAM_A, { ...TEAM_A, teamId: 'team-b' }],
        pending_invites: [],
        can_create_org: false,
      }),
    ).toBeNull();
  });
});

describe('applyWorkspaceOutcome', () => {
  function makeActions() {
    return {
      setLoginToken: vi.fn(),
      setWorkspaceChoices: vi.fn(),
      setView: vi.fn(),
      redirectTo: vi.fn(),
      startTwoFactorVerify: vi.fn(),
      startTwoFactorSetup: vi.fn(),
    };
  }

  it('stores the chooser payload and navigates to workspace-chooser', () => {
    const actions = makeActions();
    const choices: WorkspaceChoices = { teams: [TEAM_A], pending_invites: [], can_create_org: false };
    const applied = applyWorkspaceOutcome(
      { kind: 'chooser', loginToken: 'bridge.jwt', choices },
      actions,
    );

    expect(applied).toBe(true);
    expect(actions.setLoginToken).toHaveBeenCalledWith('bridge.jwt');
    expect(actions.setWorkspaceChoices).toHaveBeenCalledWith(choices);
    expect(actions.setView).toHaveBeenCalledWith('workspace-chooser');
  });

  it('redirects on a final outcome', () => {
    const actions = makeActions();
    const applied = applyWorkspaceOutcome({ kind: 'redirect', url: 'https://client.example/cb' }, actions);
    expect(applied).toBe(true);
    expect(actions.redirectTo).toHaveBeenCalledWith('https://client.example/cb');
  });

  it('starts the 2FA verify flow', () => {
    const actions = makeActions();
    const applied = applyWorkspaceOutcome({ kind: 'twofa', token: 'tok' }, actions);
    expect(applied).toBe(true);
    expect(actions.startTwoFactorVerify).toHaveBeenCalledWith('tok');
  });

  it('starts the forced 2FA setup flow', () => {
    const actions = makeActions();
    const setup = { setup_token: 'setup.jwt' };
    const applied = applyWorkspaceOutcome({ kind: 'twofa_enroll', setup }, actions);
    expect(applied).toBe(true);
    expect(actions.startTwoFactorSetup).toHaveBeenCalledWith(setup);
  });

  it('returns false for an error outcome and touches nothing', () => {
    const actions = makeActions();
    const applied = applyWorkspaceOutcome({ kind: 'error' }, actions);
    expect(applied).toBe(false);
    expect(actions.setLoginToken).not.toHaveBeenCalled();
    expect(actions.redirectTo).not.toHaveBeenCalled();
  });
});
