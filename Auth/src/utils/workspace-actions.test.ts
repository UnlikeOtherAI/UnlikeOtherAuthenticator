import { describe, expect, it, vi } from 'vitest';

import * as api from './api.js';
import {
  requestSignInCode,
  submitSessionChoices,
  submitTeamSelection,
  submitVerifyCode,
} from './workspace-actions.js';

const QUERY = {
  configUrl: 'https://client.example.com/auth-config',
  redirectUrl: 'https://client.example.com/cb',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256' as const,
  requestAccess: false,
};

describe('submitVerifyCode', () => {
  it('calls verifyLoginCode with the email/code and decodes a chooser response', async () => {
    const spy = vi.spyOn(api, 'verifyLoginCode').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        login_token: 'bridge.jwt',
        teams: [{ teamId: 't1', orgId: 'o1', name: 'Team One', role: 'member' }],
        pending_invites: [],
        can_create_org: false,
      },
    });

    const outcome = await submitVerifyCode({ email: 'jo@example.com', code: '123456', ...QUERY });

    expect(spy).toHaveBeenCalledWith({ email: 'jo@example.com', code: '123456' }, QUERY);
    expect(outcome.kind).toBe('chooser');
  });

  it('decodes a redirect response', async () => {
    vi.spyOn(api, 'verifyLoginCode').mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, redirect_to: 'https://client.example.com/cb?code=abc' },
    });

    const outcome = await submitVerifyCode({ email: 'jo@example.com', code: '123456', ...QUERY });
    expect(outcome).toEqual({ kind: 'redirect', url: 'https://client.example.com/cb?code=abc' });
  });

  it('produces a generic error outcome on an API failure', async () => {
    vi.spyOn(api, 'verifyLoginCode').mockResolvedValue({
      ok: false,
      status: 401,
      error: null,
      code: null,
    });

    const outcome = await submitVerifyCode({ email: 'jo@example.com', code: '000000', ...QUERY });
    expect(outcome).toEqual({ kind: 'error' });
  });
});

describe('submitTeamSelection', () => {
  it('calls selectTeam with the given teamId', async () => {
    const spy = vi.spyOn(api, 'selectTeam').mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, redirect_to: 'https://client.example.com/cb' },
    });

    await submitTeamSelection({ loginToken: 'bridge.jwt', teamId: 'team-1', ...QUERY });

    expect(spy).toHaveBeenCalledWith(
      { login_token: 'bridge.jwt', teamId: 'team-1', inviteId: undefined, action: undefined },
      QUERY,
    );
  });

  it('calls selectTeam with an invite accept action', async () => {
    const spy = vi.spyOn(api, 'selectTeam').mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, redirect_to: 'https://client.example.com/cb' },
    });

    await submitTeamSelection({
      loginToken: 'bridge.jwt',
      inviteId: 'invite-1',
      action: 'accept',
      ...QUERY,
    });

    expect(spy).toHaveBeenCalledWith(
      { login_token: 'bridge.jwt', teamId: undefined, inviteId: 'invite-1', action: 'accept' },
      QUERY,
    );
  });

  it('calls selectTeam with a decline action and decodes the refreshed chooser', async () => {
    vi.spyOn(api, 'selectTeam').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        login_token: 'bridge.jwt',
        teams: [],
        pending_invites: [],
        can_create_org: true,
      },
    });

    const outcome = await submitTeamSelection({
      loginToken: 'bridge.jwt',
      inviteId: 'invite-1',
      action: 'decline',
      ...QUERY,
    });

    expect(outcome.kind).toBe('chooser');
  });

  it('calls selectTeam with an empty selection for create-workspace', async () => {
    const spy = vi.spyOn(api, 'selectTeam').mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, redirect_to: 'https://client.example.com/cb' },
    });

    await submitTeamSelection({ loginToken: 'bridge.jwt', ...QUERY });

    expect(spy).toHaveBeenCalledWith(
      { login_token: 'bridge.jwt', teamId: undefined, inviteId: undefined, action: undefined },
      QUERY,
    );
  });
});

describe('requestSignInCode', () => {
  it('calls authStart with the email', async () => {
    const spy = vi
      .spyOn(api, 'authStart')
      .mockResolvedValue({ ok: true, status: 200, data: { message: 'sent' } });

    await requestSignInCode({ email: 'jo@example.com', ...QUERY });

    expect(spy).toHaveBeenCalledWith({ email: 'jo@example.com' }, QUERY);
  });
});

describe('submitSessionChoices', () => {
  it('calls fetchSessionChoices with the login_token and decodes the bare chooser payload', async () => {
    const spy = vi.spyOn(api, 'fetchSessionChoices').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        teams: [{ teamId: 't1', orgId: 'o1', name: 'Team One', role: 'member' }],
        pending_invites: [],
        can_create_org: true,
      },
    });

    const choices = await submitSessionChoices({ loginToken: 'bridge.jwt', ...QUERY });

    expect(spy).toHaveBeenCalledWith({ login_token: 'bridge.jwt' }, QUERY);
    expect(choices).toEqual({
      teams: [{ teamId: 't1', orgId: 'o1', name: 'Team One', role: 'member' }],
      pending_invites: [],
      can_create_org: true,
    });
  });

  it('returns null on an API failure', async () => {
    vi.spyOn(api, 'fetchSessionChoices').mockResolvedValue({
      ok: false,
      status: 401,
      error: null,
      code: null,
    });

    const choices = await submitSessionChoices({ loginToken: 'bridge.jwt', ...QUERY });
    expect(choices).toBeNull();
  });
});
