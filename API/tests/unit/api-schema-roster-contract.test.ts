import { describe, expect, it } from 'vitest';

import { llmRostersMarkdown } from '../../src/routes/root/llm-integration-rosters.js';
import { endpoints } from '../../src/routes/root/schema.js';

const orgRosterPath = '/org/organisations/:orgId/members';
const teamRosterPath = '/org/organisations/:orgId/teams/:teamId/members';
const candidatePath = '/org/organisations/:orgId/teams/:teamId/members/candidates';
const invitationTargetPath = '/org/organisations/:orgId/member-invitation-targets';
const pendingInvitationsPath = '/org/organisations/:orgId/member-invitations';
const teamPendingInvitationsPath = '/org/organisations/:orgId/teams/:teamId/member-invitations';
const memberWorkspacesPath = '/org/organisations/:orgId/members/:userId/workspaces';

function getEndpoint(path: string) {
  const endpoint = endpoints.find((item) => item.method === 'GET' && item.path === path);
  expect(endpoint, `missing GET ${path} in /api`).toBeDefined();
  return endpoint!;
}

describe('/api and /llm roster contract', () => {
  it('documents directional opaque pagination and action-specific permissions on both rosters', () => {
    for (const path of [orgRosterPath, teamRosterPath]) {
      const endpoint = getEndpoint(path);
      expect(endpoint.query).toHaveProperty('direction?');
      expect(endpoint.query?.['cursor?']).toContain('opaque');
      expect(endpoint.response).toHaveProperty('total');
      expect(endpoint.response).toHaveProperty('meta');
      expect(endpoint.response?.permissions).toContain('viewMemberEmail');
    }
    expect(llmRostersMarkdown).toContain('meta.nextCursor');
    expect(llmRostersMarkdown).toContain('opaque');
    expect(llmRostersMarkdown).toContain('permissions');
  });

  it('documents the manager-only, bounded, scoped candidate endpoint', () => {
    const endpoint = getEndpoint(candidatePath);
    expect(endpoint.query?.q).toContain('required');
    expect(endpoint.query?.['limit?']).toContain('max 50');
    expect(endpoint.description).toContain('ACTIVE members of this exact organisation only');
    expect(endpoint.description).toContain('excludes users already ACTIVE');
    expect(endpoint.description).toContain('never a domain-wide user lookup');
    expect(llmRostersMarkdown).toContain(candidatePath);
    expect(llmRostersMarkdown).toContain('does not search a\ndomain-wide user directory');
    expect(llmRostersMarkdown).toContain('returns no invitation feed');
  });

  it('documents distinct actionable invitation feeds and the explicit target chooser', () => {
    for (const path of [invitationTargetPath, pendingInvitationsPath, teamPendingInvitationsPath]) {
      const endpoint = getEndpoint(path);
      expect(endpoint.query?.['cursor?']).toContain('opaque');
      expect(endpoint.response).toHaveProperty('total');
      expect(endpoint.response).toHaveProperty('meta');
    }
    expect(getEndpoint(pendingInvitationsPath).description).toContain('not the owner-only');
    expect(llmRostersMarkdown).toContain('member-invitation-targets');
    expect(llmRostersMarkdown).toContain('member-invitations');
    expect(llmRostersMarkdown).toContain('active team as a silent target');
  });

  it('documents the scoped workspace-access read for an organisation member', () => {
    const endpoint = getEndpoint(memberWorkspacesPath);
    expect(endpoint.description).toContain('only teams where the caller currently holds members.manage');
    expect(endpoint.response).toHaveProperty('data');
    expect(endpoint.response?.data).toContain('hasAccess');
    expect(llmRostersMarkdown).toContain(memberWorkspacesPath);
    expect(llmRostersMarkdown).toContain('team is a workspace');
  });
});
