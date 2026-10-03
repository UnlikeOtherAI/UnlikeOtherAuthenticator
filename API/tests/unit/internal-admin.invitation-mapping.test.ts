import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAdminOrganisation, type AdminOrganisationRow } from '../../src/services/internal-admin.service.base.js';

vi.mock('../../src/utils/avatar-url.js', () => ({
  avatarImageBaseUrl: () => 'https://example.com',
  adminAvatarImageUrl: () => '/avatar',
  adminTeamAvatarImageUrl: () => '/team-avatar',
}));

afterEach(() => vi.useRealTimers());

describe('admin invitation history', () => {
  it('keeps terminal, expiry and approval state instead of describing all unaccepted invites as pending', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const current = new Date();
    const invite = { id: 'invite', email: 'person@example.com', teamId: 'team', team: { name: 'Engineering' }, teamRole: 'member', createdAt: current, approvalStatus: 'NOT_REQUIRED', acceptedAt: null, declinedAt: null, revokedAt: null, revokedReason: null, expiresAt: new Date('2026-10-04T12:00:00Z') };
    const org = { id: 'org', name: 'Acme', slug: 'acme', createdAt: current, owner: { id: 'owner', email: 'owner@example.com', name: null }, teams: [], members: [], allowedEmails: [], allowedEmailDomains: [], twoFaPolicy: null, invites: [
      { ...invite, id: 'accepted', acceptedAt: current },
      { ...invite, id: 'declined', declinedAt: current },
      { ...invite, id: 'revoked', revokedAt: current, revokedReason: 'REVOKED' },
      { ...invite, id: 'replaced', revokedAt: current, revokedReason: 'REPLACED' },
      { ...invite, id: 'expired', expiresAt: current },
      { ...invite, id: 'approval-denied', approvalStatus: 'DENIED' },
    ] } as unknown as AdminOrganisationRow;
    const records = formatAdminOrganisation(org, new Map()).preapprovedMembers;
    expect(records.map((record) => record.status)).toEqual(['accepted', 'declined', 'revoked', 'replaced', 'expired', 'pending']);
    expect(records[5]).toMatchObject({ approvalStatus: 'denied', targetTeamId: 'team', targetTeam: 'Engineering' });
    expect(records[0].approvalStatus).toBe('not_required');
  });
});
