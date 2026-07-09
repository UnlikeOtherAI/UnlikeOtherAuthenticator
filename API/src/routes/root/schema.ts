import { authEndpoints } from './schema.auth.js';
import { configDebugEndpoints } from './schema.config-debug.js';
import { integrationsEndpoints } from './schema.integrations.js';
import { internalAdminEndpoints } from './schema.internal-admin.js';
import { oauthEndpoints } from './schema.oauth.js';

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

const appEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/apps/startup',
    description: 'Server-facing startup payload combining kill switch state and resolved feature flags',
    auth: 'signed RS256 config JWT fetched from config_url, same verification path as /auth/login and /auth/register',
    query: {
      config_url: 'string (required) — HTTPS URL to fetch signed config JWT',
      appIdentifier: 'string (required) — registered app identifier, e.g. com.acme.ios',
      platform: 'string (required) — ios | android | web | macos | windows | other',
      versionName: 'string (optional) — semantic/display version',
      versionCode: 'string (optional) — Android numeric version code',
      buildNumber: 'string (optional) — iOS/macOS build number',
      userId: 'string (optional) — applies per-user flag overrides and kill-switch test targeting',
      teamId: 'string (optional) — reserved for multi-team flag resolution',
    },
    response: {
      killSwitch: 'object|null — matched kill-switch entry, or null when clear',
      flags: 'object — all resolved feature flags for the app as key:boolean',
      cacheTtl: 'number — seconds the caller may cache the response',
      serverTime: 'string — ISO timestamp',
      activatesIn: 'number (optional) — seconds until a pending kill switch activates',
    },
  },
];

const emailEndpoints: EndpointSchema[] = [
  {
    method: 'POST',
    path: '/email/send',
    description: 'Send a per-domain transactional email through UOA-managed email infrastructure',
    auth: 'X-UOA-Config-JWT header containing a signed RS256 client config JWT',
    body: {
      to: 'email address (required)',
      subject: 'string (required)',
      text: 'string (required)',
      html: 'string (optional)',
      reply_to: 'email address (optional; overrides the configured default reply-to)',
    },
    response: {
      202: '{ ok: true }',
      '401/403': 'generic error for missing/invalid config JWT or unconfigured/unverified domain email',
    },
  },
];

const orgEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/org/me',
    description: 'Current user org context',
    auth: 'access token (X-UOA-Access-Token header)',
    query: { config_url: 'string (required)' },
    response: {
      'org.workspaces': 'array — one entry per ACTIVE team membership on this domain: { teamId, orgId, name, slug, orgName, iconUrl, role, lastLoginAt }; ordered lastLoginAt DESC with nulls last, then name ASC (the sidebar order)',
      'org.pending_invites': 'array — the caller\'s pending invites on this domain: { inviteId, teamId, teamName, invitedBy, expiresAt }',
    },
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
    body: {
      name: 'string (optional)',
      'member_invites?': 'string — "allowed" (default) | "admin_approval" | "disabled"; owner/admin only, omitted leaves it unchanged; gates the member-initiated invite endpoint',
      'icon_url?': 'string | null — external HTTPS URL only, max 2048 chars; owner/admin only; omitted leaves the current icon unchanged, null clears it; non-https/oversized/invalid rejected with a generic error',
    },
    response: {
      iconUrl: 'string | null — echoed on every organisation read/write',
    },
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
    query: {
      'status?': 'string — ACTIVE (default) | DEACTIVATED | REMOVED | all',
    },
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
    description: 'Remove organisation member (soft-remove: status becomes REMOVED, tombstoned for audit; also revokes the member\'s sessions on this domain)',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/members/:userId/deactivate',
    description: 'Deactivate an organisation member: suspends access (org + team rows become DEACTIVATED, sessions on this domain revoked) without deleting history; cannot deactivate an owner (transfer ownership first)',
    auth: 'domain hash bearer token',
    response: { ok: 'true' },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/members/:userId/reactivate',
    description: 'Reactivate a DEACTIVATED organisation member (org + team rows return to ACTIVE); does not restore sessions — the user signs in again',
    auth: 'domain hash bearer token',
    response: { ok: 'true' },
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
    query: {
      'include?': 'string — exact literal "invited" adds the invited[] array below; any other value is ignored (treated as absent)',
    },
    response: {
      slug: 'string — unique team slug within the organisation',
      iconUrl: 'string | null — echoed on every team read/write',
      members: 'array — current team members',
      'invited?': 'array — present only when include=invited: pending invites for this team, { inviteId, email, inviteName, teamRole, invitedByName, invitedByEmail, lastSentAt, expiresAt, approvalStatus, openCount }; gated to org/team owner/admin (invite emails are PII) — a plain member gets [] here, never a 403; absent entirely when ?include=invited is not passed',
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
      'joinPolicy?': 'string — INVITE_ONLY (default) | APPROVED_DOMAIN | REQUEST_TO_JOIN | OPEN_TO_ORG | HIDDEN; owner/admin only, omitted leaves the current policy unchanged',
      'icon_url?': 'string | null — external HTTPS URL only, max 2048 chars; owner/admin only; omitted leaves the current icon unchanged, null clears it; non-https/oversized/invalid rejected with a generic error',
    },
    response: {
      slug: 'string — unique team slug within the organisation',
      iconUrl: 'string | null — echoed on every team read/write',
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
    path: '/org/organisations/:orgId/teams/:teamId/join',
    description: 'Self-join a team whose joinPolicy is OPEN_TO_ORG (caller must be an ACTIVE member of the team\'s org); reactivates a previously removed/deactivated membership instead of duplicating it',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    response: {
      200: 'team member record',
      400: 'generic error — team not found, policy is not OPEN_TO_ORG, or already an active member',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invitations',
    description: 'Dual-mode: with an X-UOA-Access-Token header, a single member-initiated invite gated by the org\'s member_invites setting (owner/admin always allowed; plain member per setting; no email enumeration in the response). Without that header, the original trusted-backend bulk invite (unchanged).',
    auth: 'domain hash bearer token; add access token (X-UOA-Access-Token header) for the member-initiated variant',
    body: {
      'redirectUrl?': 'string — optional final OAuth redirect URL',
      'invitedBy?': 'object — backend-only variant: optional inviter metadata { userId?, name?, email? }',
      'invites?': 'array (backend-only variant, required, 1-200) — [{ email: string, name?: string, teamRole?: string }]',
      'email?': 'string — member-initiated variant (required instead of invites)',
      'name?': 'string — member-initiated variant',
      'teamRole?': 'string — member-initiated variant',
    },
    response: {
      results: 'array (backend-only variant) — per-email status: invited | resent_existing | already_member | existing_user | conflict',
      status: '"ok" (member-initiated variant) — always the same shape regardless of outcome (no enumeration)',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/invitations',
    description: 'List invitation history for a team',
    auth: 'domain hash bearer token',
    response: {
      data: 'array — invite records with status (pending|accepted|declined|replaced|expired), approval_status (not_required|pending|approved|denied), expiresAt, inviter, send/open, accepted/declined state',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId/resend',
    description: 'Resend a pending team invitation email; refreshes the invite\'s expiry to now + 30 days',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/invitations',
    description: 'List invites awaiting member-invite approval for the organisation (requires ?approval=pending)',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header), owner/admin only',
    query: { approval: 'string (required) — must be "pending"' },
    response: { data: 'array — invite records with approval_status: pending' },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/invitations/:inviteId/approve',
    description: 'Approve a PENDING member-initiated invite: sets approval_status APPROVED and sends the invite email',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header), owner/admin only',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/invitations/:inviteId/deny',
    description: 'Deny a PENDING member-initiated invite: sets approval_status DENIED; sends nothing (silent to the invitee)',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header), owner/admin only',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invite-links',
    description: 'Create a shareable team invite link (Slack-style). Owner/admin (org or team) only; refused (generic error) when the team\'s joinPolicy is HIDDEN. roleToAssign may be "member" (default) or "admin" — never "owner". Returns the plaintext token ONCE; only its hash is stored.',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    body: {
      'roleToAssign?': 'string — "member" (default) | "admin"',
      'maxUses?': 'number — capped at 400 (default 400)',
      'expiresInDays?': 'number — capped at 30 (default 30)',
    },
    response: {
      token: 'string — the plaintext invite-link token; shown only in this response',
      link: 'object — { id, roleToAssign, expiresAt, maxUses, useCount, revokedAt, createdAt } (never the token)',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/invite-links',
    description: 'List invite links for a team (never includes the token itself)',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    response: {
      data: 'array — { id, roleToAssign, expiresAt, maxUses, useCount, revokedAt, createdAt }',
    },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId/invite-links/:linkId',
    description: 'Revoke a team invite link; idempotent (revoking an already-revoked link succeeds)',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    response: { revoked: 'true' },
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
  ...appEndpoints,
  ...emailEndpoints,
  ...domainEndpoints,
  ...orgEndpoints,
  ...integrationsEndpoints,
  ...internalAdminEndpoints,
  ...oauthEndpoints,
];
