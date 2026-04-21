import { authEndpoints } from './schema.auth.js';
import { configDebugEndpoints } from './schema.config-debug.js';
import { internalAdminEndpoints } from './schema.internal-admin.js';

export type EndpointSchema = {
  method: string;
  path: string;
  description: string;
  auth?: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
  response?: Record<string, string>;
};

const baseEndpoints: EndpointSchema[] = [
  { method: 'GET', path: '/', description: 'Holding page linking to Admin, /llm, and /api' },
  { method: 'GET', path: '/api', description: 'API information and full endpoint schema' },
  { method: 'GET', path: '/llm', description: 'Markdown integration guide for LLMs and humans; links /api for JSON schema' },
  {
    method: 'GET',
    path: '/.well-known/jwks.json',
    description: 'Public JWKS used to verify RS256 config JWT signatures',
    auth: 'public',
    response: { keys: 'array — public RSA JWKs only; private key members are rejected at boot-time use' },
  },
  { method: 'GET', path: '/health', description: 'Health check' },
  {
    method: 'GET',
    path: '/admin/*',
    description: 'First-party UOA Admin CSR app served from the API origin',
    response: { 200: 'Admin HTML shell or static asset' },
  },
];

const domainEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/domain/users',
    description: 'List users for a domain',
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      limit: 'number (optional)',
    },
  },
  {
    method: 'GET',
    path: '/domain/logs',
    description: 'Login logs for a domain',
    auth: 'domain hash bearer token',
    query: {
      domain: 'string (required)',
      limit: 'number (optional)',
    },
  },
  {
    method: 'GET',
    path: '/domain/debug',
    description: 'Debug info (requires debug_enabled in config)',
    auth: 'domain hash bearer token',
    query: { domain: 'string (required)' },
  },
];

const orgEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/org/me',
    description: 'Current user org context',
    auth: 'access token (X-UOA-Access-Token header)',
    query: { config_url: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/org/organisations',
    description: 'List organisations for domain',
    auth: 'domain hash bearer token',
    query: { config_url: 'string (required)' },
  },
  {
    method: 'POST',
    path: '/org/organisations',
    description: 'Create organisation',
    auth: 'domain hash bearer token',
    body: { name: 'string (required)', owner_id: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId',
    description: 'Get organisation details',
    auth: 'domain hash bearer token',
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId',
    description: 'Update organisation',
    auth: 'domain hash bearer token',
    body: { name: 'string (optional)' },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId',
    description: 'Delete organisation',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/members',
    description: 'List organisation members',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/members',
    description: 'Add organisation member',
    auth: 'domain hash bearer token',
    body: { user_id: 'string (required)', role: 'string (optional)' },
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/members/:userId',
    description: 'Change member role',
    auth: 'domain hash bearer token',
    body: { role: 'string (required)' },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/members/:userId',
    description: 'Remove organisation member',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/transfer-ownership',
    description: 'Transfer organisation ownership',
    auth: 'domain hash bearer token',
    body: { new_owner_id: 'string (required)' },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams',
    description: 'List teams',
    auth: 'domain hash bearer token',
    response: {
      data: 'array — team records including id, name, slug, description, groupId, isDefault',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams',
    description: 'Create team',
    auth: 'domain hash bearer token',
    body: {
      name: 'string (required)',
      'slug?': 'string — optional custom team slug; otherwise derived from name',
      description: 'string (optional)',
    },
    response: {
      slug: 'string — unique team slug within the organisation',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId',
    description: 'Get team details (includes members)',
    auth: 'domain hash bearer token',
    response: {
      slug: 'string — unique team slug within the organisation',
      members: 'array — current team members',
    },
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/teams/:teamId',
    description: 'Update team',
    auth: 'domain hash bearer token',
    body: {
      name: 'string (optional)',
      'slug?': 'string — optional custom team slug; omitted leaves the current slug unchanged',
      description: 'string (optional)',
    },
    response: {
      slug: 'string — unique team slug within the organisation',
    },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId',
    description: 'Delete team',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invitations',
    description: 'Bulk invite users to a team and send invitation emails',
    auth: 'domain hash bearer token',
    body: {
      'redirectUrl?': 'string — optional final OAuth redirect URL',
      'invitedBy?': 'object — optional inviter metadata { userId?, name?, email? }',
      invites: 'array (required, 1-200) — [{ email: string, name?: string, teamRole?: string }]',
    },
    response: {
      results: 'array — per-email status: invited | resent_existing | already_member | conflict',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/invitations',
    description: 'List invitation history for a team',
    auth: 'domain hash bearer token',
    response: {
      data: 'array — invite records with status, inviter, send/open, accepted/declined state',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId/resend',
    description: 'Resend a pending team invitation email',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/access-requests',
    description: 'List access requests for the configured team',
    auth: 'domain hash bearer token',
    query: {
      config_url: 'string (required)',
      domain: 'string (required) — must match the config domain for domain-hash auth',
      status: 'string (optional) — pending | approved | rejected',
    },
    response: {
      data: 'array — access requests with requester, status, timestamps, reviewer metadata',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/access-requests/:requestId/approve',
    description: 'Approve an access request and add the user to the configured team',
    auth: 'domain hash bearer token',
    query: {
      config_url: 'string (required)',
      domain: 'string (required) — must match the config domain for domain-hash auth',
    },
    body: {
      reviewedByUserId: 'string (optional) — reviewer user ID recorded with the approval',
      reviewReason: 'string (optional, max 500) — free-form audit note',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/access-requests/:requestId/reject',
    description: 'Reject an access request for the configured team',
    auth: 'domain hash bearer token',
    query: {
      config_url: 'string (required)',
      domain: 'string (required) — must match the config domain for domain-hash auth',
    },
    body: {
      reviewedByUserId: 'string (optional) — reviewer user ID recorded with the rejection',
      reviewReason: 'string (optional, max 500) — free-form audit note',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/members',
    description: 'Add team member',
    auth: 'domain hash bearer token',
    body: { user_id: 'string (required)', team_role: 'string (optional)' },
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/teams/:teamId/members/:userId',
    description: 'Change team member role',
    auth: 'domain hash bearer token',
    body: { team_role: 'string (required)' },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId/members/:userId',
    description: 'Remove team member',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/groups',
    description: 'List groups',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/groups/:groupId',
    description: 'Get group details',
    auth: 'domain hash bearer token',
  },
];

export const endpoints: EndpointSchema[] = [
  ...baseEndpoints,
  ...configDebugEndpoints,
  ...authEndpoints,
  ...domainEndpoints,
  ...orgEndpoints,
  ...internalAdminEndpoints,
];
