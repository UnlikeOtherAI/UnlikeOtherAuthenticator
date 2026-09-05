import { describe, expect, it, vi } from 'vitest';

import { resolveEmailInviteContinuation } from '../../src/services/email-invite-continuation.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { AppError } from '../../src/utils/errors.js';

const config = { domain: 'client.example.com' } as unknown as ClientConfig;
const params = { token: 'invite-token', configUrl: 'https://client.example.com/config', config };

function landingData(tokenType: 'LOGIN_LINK' | 'VERIFY_EMAIL' | 'VERIFY_EMAIL_SET_PASSWORD') {
  return {
    tokenType,
    inviteId: 'invite-1',
    email: 'invitee@example.com',
    inviteName: null,
    teamName: 'Hugo',
    organisationName: 'Hugo_org',
  };
}

describe('resolveEmailInviteContinuation', () => {
  it('reports no invitation for a plain email link', async () => {
    const result = await resolveEmailInviteContinuation(params, {
      getTeamInviteLandingData: vi.fn().mockRejectedValue(new AppError('BAD_REQUEST', 400)),
      verifyEmailToken: vi.fn(),
    });

    expect(result).toEqual({ kind: 'none' });
  });

  it('sends a brand-new account to the invite registration screen', async () => {
    const verifyEmailToken = vi.fn();
    const result = await resolveEmailInviteContinuation(params, {
      getTeamInviteLandingData: vi.fn().mockResolvedValue(landingData('VERIFY_EMAIL_SET_PASSWORD')),
      verifyEmailToken,
    });

    expect(result).toEqual({ kind: 'registration', email: 'invitee@example.com' });
    // Nothing is consumed: the invitee still has to create their account.
    expect(verifyEmailToken).not.toHaveBeenCalled();
  });

  it('accepts the invitation for an account that already exists', async () => {
    const verifyEmailToken = vi.fn().mockResolvedValue({
      userId: 'user-1',
      credentialEpoch: 1,
      type: 'LOGIN_LINK',
      twoFaEnabled: false,
      acceptedInvite: { inviteId: 'invite-1', orgId: 'org-1', teamId: 'team-1' },
    });

    const result = await resolveEmailInviteContinuation(params, {
      getTeamInviteLandingData: vi.fn().mockResolvedValue(landingData('LOGIN_LINK')),
      verifyEmailToken,
    });

    expect(result).toEqual({ kind: 'accepted', teamName: 'Hugo', organisationName: 'Hugo_org' });
    expect(verifyEmailToken).toHaveBeenCalledTimes(1);
  });

  it('surfaces a refused acceptance rather than silently dropping the invitation', async () => {
    const error = new AppError('BAD_REQUEST', 400, 'ORG_CONFLICT_ON_DOMAIN');
    const result = await resolveEmailInviteContinuation(params, {
      getTeamInviteLandingData: vi.fn().mockResolvedValue(landingData('LOGIN_LINK')),
      verifyEmailToken: vi.fn().mockRejectedValue(error),
    });

    expect(result).toEqual({ kind: 'unavailable', error });
  });

  it('refuses when the token was invitation-bound but nothing was accepted', async () => {
    const result = await resolveEmailInviteContinuation(params, {
      getTeamInviteLandingData: vi.fn().mockResolvedValue(landingData('VERIFY_EMAIL')),
      verifyEmailToken: vi.fn().mockResolvedValue({
        userId: 'user-1',
        credentialEpoch: 1,
        type: 'VERIFY_EMAIL',
        twoFaEnabled: false,
        acceptedInvite: null,
      }),
    });

    expect(result.kind).toBe('unavailable');
  });

  it('lets an infrastructure failure surface instead of degrading to a login restart', async () => {
    await expect(
      resolveEmailInviteContinuation(params, {
        getTeamInviteLandingData: vi.fn().mockRejectedValue(new TypeError('socket closed')),
        verifyEmailToken: vi.fn(),
      }),
    ).rejects.toThrow('socket closed');
  });
});
