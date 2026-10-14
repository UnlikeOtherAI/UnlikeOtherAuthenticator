import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/env.js', () => ({ getEnv: () => ({}) }));

import { formatAdminOrganisation } from '../../src/services/internal-admin.service.base.js';

describe('admin organisation member states', () => {
  it.each([
    ['ACTIVE', 'ACTIVE', 'active', 'active'],
    ['DISABLED', 'ACTIVE', 'disabled', 'active'],
    ['ACTIVE', 'DEACTIVATED', 'active', 'deactivated'],
    ['ACTIVE', 'REMOVED', 'active', 'removed'],
    ['BANNED', 'REMOVED', 'banned', 'removed'],
    ['DELETING', 'DEACTIVATED', 'deleting', 'deactivated'],
    ['DELETED', 'REMOVED', 'deleted', 'removed'],
  ])('preserves account %s and membership %s independently', (
    lifecycleStatus, membershipStatus, expectedAccount, expectedMembership,
  ) => {
    const org = {
      id: 'org-1', name: 'Example', slug: 'example', twoFaPolicy: null,
      allowedEmailDomains: [], allowedEmails: [], createdAt: new Date('2026-10-14'),
      owner: null, teams: [], invites: [],
      members: [{ userId: 'subject-1', role: 'member', status: membershipStatus,
        user: { id: 'subject-1', name: 'Example Person', email: 'person@example.com',
          twoFaEnabled: false, lifecycleStatus } }],
    } as unknown as Parameters<typeof formatAdminOrganisation>[0];

    expect(formatAdminOrganisation(org, new Map()).members[0]).toMatchObject({
      id: 'subject-1', status: expectedAccount, membershipStatus: expectedMembership,
    });
  });
});
