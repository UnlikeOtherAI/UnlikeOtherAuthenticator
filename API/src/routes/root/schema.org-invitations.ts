import type { EndpointSchema } from './schema.js';

// Team invitations (bulk + member-initiated), invite links, and access requests.
export const orgInvitationEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/org/organisations/:orgId/member-invitation-targets',
    description:
      'Cursor-paged explicit team chooser for the Members invitation dialog. It contains only teams in this exact organisation for which the caller currently holds members.manage; it never infers authority from a selected team or from the product session.',
    auth: 'domain hash bearer token plus optional user credential; backend mode receives all teams',
    query: {
      'limit?': 'number — page size, max 200',
      'direction?': 'forward (default) | backward',
      'cursor?': 'opaque signed keyset cursor from meta.nextCursor or meta.prevCursor',
    },
    response: {
      data: 'array — { id, name, slug, avatarImageUrl }',
      total: 'number — teams the caller may target with an invitation',
      meta: 'object — { hasMore, nextCursor, prevCursor }',
      permissions: 'object — { createInvitation }',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/member-invitations',
    description:
      'Organisation-wide cursor-paged feed of actionable TeamInvite records for the Members Pending invitations tab. This is not the owner-only member-invite approval queue: every row names its exact target team, and results are limited to teams where the caller currently holds members.manage.',
    auth: 'domain hash bearer token plus optional user credential; backend mode receives all teams',
    query: {
      'limit?': 'number — page size, max 200',
      'direction?': 'forward (default) | backward',
      'cursor?': 'opaque signed keyset cursor from meta.nextCursor or meta.prevCursor',
    },
    response: {
      data: 'array — actionable invite records with status (pending|expired), full invitee email and target team { id, name, slug, avatarImageUrl }',
      total: 'number — actionable invitation count for the permitted target teams',
      meta: 'object — { hasMore, nextCursor, prevCursor }',
      permissions: 'object — { createInvitation, viewPendingInvitations }',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/member-invitations',
    description:
      'The exact-team form of the actionable Pending invitations feed for the team Members page. Its pagination envelope and row shape are identical to the organisation-wide feed; a caller without members.manage for this team receives no invite data.',
    auth: 'domain hash bearer token plus optional user credential; backend mode receives the exact team',
    query: {
      'limit?': 'number — page size, max 200',
      'direction?': 'forward (default) | backward',
      'cursor?': 'opaque signed keyset cursor from meta.nextCursor or meta.prevCursor',
    },
    response: {
      data: 'array — actionable invite records with target team identity',
      total: 'number — actionable invitation count for this exact team',
      meta: 'object — { hasMore, nextCursor, prevCursor }',
      permissions: 'object — { createInvitation, viewPendingInvitations }',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invitations',
    description:
      "Dual-mode: with an X-UOA-Access-Token header, a single member-initiated invite gated by the org's member_invites setting (a members.manage holder — org/team owner/admin by default — always allowed; anyone else per setting; no email enumeration in the response). Without that header, the original trusted-backend bulk invite (unchanged).",
    auth: 'domain hash bearer token; add access token (X-UOA-Access-Token header) for the member-initiated variant',
    body: {
      'redirectUrl?': 'string — optional final OAuth redirect URL',
      'invitedBy?':
        'object — backend-only variant: optional inviter metadata { userId?, name?, email? }',
      'invites?':
        'array (backend-only variant, required, 1-200) — [{ email: string, name?: string, teamRole?: string }]',
      'email?': 'string — member-initiated variant (required instead of invites)',
      'name?': 'string — member-initiated variant',
      'teamRole?':
        'string — member-initiated variant. Validated against org_features.team_roles (default owner|admin|member); owner is never invitable and is rejected with the generic 400. At most one actionable invite (not accepted/declined/revoked, approval not denied) exists per team + lowercased email — inviting an address that already holds one replaces it and reports resent_existing',
    },
    response: {
      results:
        'array (backend-only variant) — one object per submitted email: { email, status: invited | resent_existing | already_member | existing_user | conflict, invite? }. The invite key carries the full invitation record — including its id, for a later GET/resend/DELETE by id — on invited and resent_existing rows only; the three no-invitation outcomes carry email + status alone',
      status:
        '"ok" (member-initiated variant) — always the same shape regardless of outcome (no enumeration)',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/invitations',
    description: 'List invitation history for a team',
    auth: 'domain hash bearer token',
    response: {
      data: 'array — invite records with status (pending|accepted|declined|replaced|revoked|expired), approvalStatus (not_required|pending|approved|denied), expiresAt, inviter, send/open, accepted/declined/revoked state, plus invitedByAvatarImageUrl and acceptedAvatarImageUrl (null until the matching user id exists; the invitee email never gets one)',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId',
    description:
      'Read one team invitation by id — the by-id companion to the invitation list, for a caller holding an id from a bulk-invite result, the list, or a resend. Read-only: nothing is written and no audit row is produced.',
    auth: 'domain hash bearer token',
    response: {
      200: 'invite record — exactly the shape the list returns per entry, including status (pending|accepted|declined|replaced|revoked|expired), approvalStatus (not_required|pending|approved|denied), expiresAt, inviter, send/open, accepted/declined/revoked state, invitedByAvatarImageUrl and acceptedAvatarImageUrl',
      404: 'generic — unknown invite id, an invitation belonging to a foreign org/team, or cross-domain (no existence leak)',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId/resend',
    description:
      "Resend a pending team invitation email; refreshes the invite's expiry to now + 30 days. Only an actionable invitation with settled approval can be resent: accepted, declined, revoked, approval-denied, and still-awaiting-approval invitations all answer the generic 400, so a resend can neither resurrect a revoked invitation nor mail an unapproved one",
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId/accept',
    description:
      'Accept an exact team invitation for its invitee through backend mode. The product asserts the invitee\'s UOA user id; acceptance creates the ACTIVE org/team memberships and marks the invite accepted atomically. Repeating the exact accepted invite with the same userId is idempotent-success. Unknown or mismatched ids, email mismatch, revoked/expired/unapproved invitations, and every other refusal remain generic.',
    auth: 'backend mode only: domain hash bearer token with no X-UOA-Access-Token; requires org_features.backend_org_management=true',
    body: {
      userId: 'string (required, trimmed, non-empty) — UOA user id of the invitee asserted by the product backend',
    },
    response: {
      200: '{ ok: true, orgId, teamId }',
      400: 'generic for invalid or mismatched invitation state',
      401: 'ACCESS_TOKEN_NOT_ALLOWED when X-UOA-Access-Token is present; MISSING_ACCESS_TOKEN when backend_org_management is not enabled',
    },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId',
    description:
      'Revoke a pending invitation (sent or still awaiting member-invite approval): the invite row is kept with status "revoked", outstanding emailed tokens are consumed, and the invite link refuses acceptance. Idempotent — revoking an already-revoked (or declined) invitation succeeds. User mode: a holder of the members.manage capability (org/team owner/admin under the default grant table) or the original inviter. Backend mode (header omitted): requires org_features.backend_org_management; audited with actor_user_id null + uoa_actor { via: "domain_backend" }.',
    auth: 'domain hash bearer token; access token (X-UOA-Access-Token header) optional — omit for backend mode',
    response: {
      200: '{ ok: true } (also for an already-revoked invitation)',
      403: 'caller holds neither members.manage in this team nor authorship of the invitation',
      404: 'generic — unknown invite id, foreign org/team, or cross-domain (no existence leak)',
      409: 'code INVITATION_ALREADY_ACCEPTED — the invitation was already accepted; remove the member instead',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/invitations',
    description:
      'List invites awaiting member-invite approval for the organisation (requires ?approval=pending)',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header), owner/admin only',
    query: { approval: 'string (required) — must be "pending"' },
    response: {
      data: 'array — invite records with approvalStatus: pending, each carrying invitedByAvatarImageUrl and acceptedAvatarImageUrl (null until the matching user id exists)',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/invitations/:inviteId/approve',
    description:
      'Approve a pending member-initiated invite: sets approvalStatus to approved and sends the invite email',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header), owner/admin only',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/invitations/:inviteId/deny',
    description:
      'Deny a pending member-initiated invite: sets approvalStatus to denied; sends nothing (silent to the invitee)',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header), owner/admin only',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/invite-links',
    description:
      'Create a shareable team invite link (Slack-style). Requires the members.manage capability (org/team owner/admin under the default grant table); refused (generic error) when the team\'s joinPolicy is HIDDEN. roleToAssign may be any role in org_features.team_roles except "owner", defaulting to "member". Returns the plaintext token ONCE; only its hash is stored.',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    body: {
      'roleToAssign?':
        'string — any role in org_features.team_roles except "owner"; defaults to "member"',
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
    description:
      'List invite links for a team (never includes the token itself). Requires the members.manage capability.',
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    response: {
      data: 'array — { id, roleToAssign, expiresAt, maxUses, useCount, revokedAt, createdAt }',
    },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId/invite-links/:linkId',
    description:
      'Revoke a team invite link; idempotent (revoking an already-revoked link succeeds). Requires the members.manage capability.',
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
      data: 'array — access requests with requester, status, timestamps, reviewer metadata, plus avatarImageUrl for the requesting userId (null when the request has no user yet)',
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
];
