import { describe, expect, it } from 'vitest';

import { llmIntegrationMarkdown } from '../../src/routes/root/llm-integration.js';
import { endpoints } from '../../src/routes/root/schema.js';
import { toInviteRecord } from '../../src/services/team-invite.service.base.js';

/**
 * `/api` is the machine-readable contract (CLAUDE.md "API Schema & /llm Endpoint"), so a field name
 * documented there has to be the key an integrator can actually read off the JSON. The invite
 * endpoints documented `approval_status` while `toInviteRecord` serializes `approvalStatus`, and an
 * integrator following the schema parsed a key that is always `undefined`. Pin the documented name
 * to the serialized one so the two cannot drift apart again.
 */

const NOW = new Date('2026-07-29T00:00:00.000Z');

// invitedByUserId/acceptedUserId stay null so the record needs no avatar base URL from the env.
const INVITE_ROW = {
  id: 'inv_1',
  orgId: 'org_1',
  teamId: 'team_1',
  email: 'new.hire@acme.com',
  inviteName: 'New Hire',
  teamRole: 'member',
  redirectUrl: null,
  invitedByUserId: null,
  invitedByName: 'Alice Admin',
  invitedByEmail: 'alice@acme.com',
  acceptedUserId: null,
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
  revokedReason: null,
  openedAt: null,
  openCount: 0,
  lastSentAt: NOW,
  expiresAt: new Date('2026-08-28T00:00:00.000Z'),
  approvalStatus: 'PENDING',
  requestedByUserId: 'user_1',
  createdAt: NOW,
  updatedAt: NOW,
};

const INVITE_ENDPOINT_PATHS = [
  '/org/organisations/:orgId/teams/:teamId',
  '/org/organisations/:orgId/teams/:teamId/invitations',
  '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId',
  '/org/organisations/:orgId/invitations',
  '/org/organisations/:orgId/invitations/:inviteId/approve',
  '/org/organisations/:orgId/invitations/:inviteId/deny',
];

function endpointText(path: string): string {
  const matches = endpoints.filter((endpoint) => endpoint.path === path);
  expect(matches.length, `no /api entry for ${path}`).toBeGreaterThan(0);

  return matches
    .map((endpoint) =>
      [
        endpoint.description,
        ...Object.values(endpoint.response ?? {}),
        ...Object.values(endpoint.body ?? {}),
      ].join('\n'),
    )
    .join('\n');
}

describe('/api invite response contract', () => {
  it('serializes the approval status as camelCase approvalStatus', () => {
    const record = toInviteRecord(INVITE_ROW, NOW, 'acme.com');

    expect(Object.keys(record)).toContain('approvalStatus');
    expect(Object.keys(record)).not.toContain('approval_status');
    expect(record.approvalStatus).toBe('pending');
  });

  it.each(INVITE_ENDPOINT_PATHS)('documents no snake_case approval_status for %s', (path) => {
    expect(endpointText(path)).not.toContain('approval_status');
  });

  it('names approvalStatus on both invite-listing endpoints', () => {
    expect(endpointText('/org/organisations/:orgId/teams/:teamId/invitations')).toContain(
      'approvalStatus',
    );
    expect(endpointText('/org/organisations/:orgId/invitations')).toContain('approvalStatus');
  });

  it('keeps /llm consistent with /api on the field name', () => {
    expect(llmIntegrationMarkdown).toContain('approvalStatus');
    expect(llmIntegrationMarkdown).not.toContain('approval_status');
  });

  it('documents the revoked status and the revoke endpoint on both contract surfaces', () => {
    const record = toInviteRecord(
      { ...INVITE_ROW, revokedAt: NOW, revokedReason: 'REVOKED' },
      NOW,
      'acme.com',
    );
    expect(record.status).toBe('revoked');

    expect(
      endpointText('/org/organisations/:orgId/teams/:teamId/invitations/:inviteId'),
    ).toContain('INVITATION_ALREADY_ACCEPTED');
    expect(endpointText('/org/organisations/:orgId/teams/:teamId/invitations')).toContain(
      'revoked',
    );
    expect(llmIntegrationMarkdown).toContain(
      'DELETE /org/organisations/:orgId/teams/:teamId/invitations/:inviteId',
    );
    expect(llmIntegrationMarkdown).toContain('INVITATION_ALREADY_ACCEPTED');
  });
});
