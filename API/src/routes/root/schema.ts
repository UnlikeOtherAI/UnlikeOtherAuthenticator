import { authEndpoints } from './schema.auth.js';
import { avatarEndpoints, IDENTITY_AVATAR_URL_NOTE } from './schema.avatars.js';
import { billingEndpoints } from './schema.billing.js';
import { configDebugEndpoints } from './schema.config-debug.js';
import { integrationsEndpoints } from './schema.integrations.js';
import { internalAdminEndpoints } from './schema.internal-admin.js';
import { oauthEndpoints } from './schema.oauth.js';
import { appEndpoints, baseEndpoints, domainEndpoints, emailEndpoints } from './schema.platform.js';
import { signatureEndpoints } from './schema.signatures.js';

export type EndpointSchema = {
  method: string;
  path: string;
  description: string;
  auth?: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
  response?: Record<string, string>;
  notes?: string;
};

const orgEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/org/me',
    description: 'Current user org context and complete authorized workspace directory',
    auth: 'access token (X-UOA-Access-Token header)',
    query: { config_url: 'string (required)' },
    response: {
      org:
        'object | absent — live legacy org context plus the directory fields below. Normally anchored to the active same-domain organisation. For an `all_active_memberships` product whose selected workspace belongs to another domain, it is anchored to the token’s exact `active.orgId` after that organisation and the product policy are revalidated live. It remains absent when neither live context exists; an unscoped token never causes an arbitrary cross-domain org to be synthesized.',
      'org.workspaces':
        'array — one entry per ACTIVE team membership on this domain, or every active membership when this product is explicitly mapped to `all_active_memberships`: { teamId, orgId, name, slug, orgName, iconUrl, avatarImageUrl, role, lastLoginAt }. Each entry carries its own orgId/orgName; do not assume it belongs to the singular legacy org.org_id. avatarImageUrl is the public /teams/:teamId/avatar form (never null, no credential needed). Entries are ordered lastLoginAt DESC with nulls last, then name ASC (the sidebar order). Cross-product entries have null `lastLoginAt`.',
      'org.pending_invites':
        "array — the caller's pending invites on this domain: { inviteId, teamId, teamName, invitedBy, expiresAt }",
    },
  },
  {
    method: 'GET',
    path: '/org/organisations',
    description: 'List organisations for domain',
    auth: 'domain hash bearer token',
    query: {
      config_url: 'string (required)',
      'limit?': 'number — page size, max 200',
      'cursor?': 'string — id of the last row of the previous page (from next_cursor)',
    },
    response: { data: 'array — organisation records', next_cursor: 'string | null' },
  },
  {
    method: 'POST',
    path: '/org/organisations',
    description:
      'Create organisation owned by the calling user (X-UOA-Access-Token). Non-superusers also require org_features.allow_user_create_org=true, else 403 ORG_CREATION_NOT_ALLOWED.',
    auth: 'domain hash bearer token + X-UOA-Access-Token header (the new org owner)',
    body: { name: 'string (required, 1-100)' },
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
    description:
      'Update organisation. User mode requires the organisation.manage capability at ORG scope (org_features.role_grants); team standing never authorises it, because administering a team confers nothing over the organisation containing it. Under the default grant table that is org owner/admin, unchanged.',
    auth: 'domain hash bearer token',
    body: {
      name: 'string (optional)',
      'member_invites?':
        'string — "allowed" (default) | "admin_approval" | "disabled"; same organisation.manage gate, omitted leaves it unchanged; gates the member-initiated invite endpoint',
      'icon_url?':
        'string | null — external HTTPS URL only, max 2048 chars; same organisation.manage gate; omitted leaves the current icon unchanged, null clears it; non-https/oversized/invalid rejected with a generic error',
    },
    response: {
      iconUrl: 'string | null — echoed on every organisation read/write',
    },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId',
    description:
      'Delete organisation. Deliberately NOT a capability: the acting user must BE Organisation.ownerId, a structural invariant no grant table can reach.',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/members',
    description: 'List organisation members',
    auth: 'domain hash bearer token',
    query: {
      'status?': 'string — ACTIVE (default) | DEACTIVATED | REMOVED | all',
      'limit?': 'number — page size, max 200',
      'cursor?': 'string — id of the last row of the previous page (from next_cursor)',
    },
    response: {
      data: 'array — member records',
      next_cursor: 'string | null',
      'data[].avatarImageUrl':
        "string — the member's avatar image URL, fetchable with the same domain hash bearer",
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/members',
    description:
      'Add organisation member. User mode requires the members.manage capability at ORG scope (org_features.role_grants) — org owner/admin under the default table. Granting the "owner" role additionally requires the actor to BE an owner: owner is the one fixed role, so no grant reaches it.',
    auth: 'domain hash bearer token',
    body: {
      user_id: 'string (required)',
      role: 'string (optional, default "member") — validated against org_features.org_roles',
    },
    response: {
      avatarImageUrl:
        "string — the member's avatar image URL, fetchable with the same domain hash bearer",
    },
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/members/:userId',
    description:
      'Change member role. Deliberately NOT a capability: the acting user must BE Organisation.ownerId. The new role is validated against org_features.org_roles.',
    auth: 'domain hash bearer token',
    body: { role: 'string (required)' },
    response: {
      avatarImageUrl:
        "string — the member's avatar image URL, fetchable with the same domain hash bearer",
    },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/members/:userId',
    description:
      "Remove organisation member (soft-remove: status becomes REMOVED; atomically revokes exact user+org refresh families across product domains plus legacy sessions on this domain). User mode requires the members.manage capability at ORG scope; removing an owner additionally requires the actor to BE an owner.",
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/members/:userId/deactivate',
    description:
      'Deactivate an organisation member: suspends access and atomically revokes exact user+org refresh families across product domains plus legacy sessions on this domain; cannot deactivate an owner. Same members.manage gate as add/remove — deactivation is roster mutation, not a separate authority.',
    auth: 'domain hash bearer token',
    response: { ok: 'true' },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/members/:userId/reactivate',
    description:
      'Reactivate a DEACTIVATED organisation member (org + team rows return to ACTIVE); does not restore sessions — the user signs in again. Same members.manage gate as add/remove.',
    auth: 'domain hash bearer token',
    response: { ok: 'true' },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/transfer-ownership',
    description:
      'Transfer organisation ownership. Deliberately NOT a capability: the acting user must BE Organisation.ownerId.',
    auth: 'domain hash bearer token',
    body: {
      newOwnerId: 'string (required) — alias: newOwnerUserId; send exactly one',
      'previousOwnerRole?':
        'string — the org role the outgoing owner is left with. Validated against this domain org_features.org_roles like any other role write, and must not be "owner". Omitted: "admin" when the vocabulary contains it, else the first non-owner role in it; a vocabulary of only "owner" refuses the transfer.',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams',
    description: 'List teams',
    auth: 'domain hash bearer token',
    query: {
      'limit?': 'number — page size, max 200',
      'cursor?': 'string — id of the last row of the previous page (from next_cursor)',
    },
    response: {
      data: 'array — team records including id, name, slug, description, groupId, isDefault, iconUrl and avatarImageUrl (the always-resolving team avatar image URL, fetchable with the same domain hash bearer — Docs/Auth/avatars.md §11)',
      next_cursor: 'string | null',
    },
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams',
    description:
      'Create team. User mode requires the teams.manage capability at ORG scope — there is no team to stand in yet, so team-scope standing never authorises this. Under the default grant table that is org owner/admin, unchanged.',
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
      'include?':
        'string — exact literal "invited" adds the invited[] array below; any other value is ignored (treated as absent)',
    },
    response: {
      slug: 'string — unique team slug within the organisation',
      iconUrl: 'string | null — echoed on every team read/write',
      avatarImageUrl:
        'string — always-resolving team avatar image URL (Docs/Auth/avatars.md §11), fetchable with the same domain hash bearer; never null, unlike iconUrl',
      members:
        'array — current team members; each carries avatarImageUrl, fetchable with the same domain hash bearer',
      'invited?':
        'array — present only when include=invited: pending invites for this team, { inviteId, email, inviteName, teamRole, invitedByName, invitedByEmail, invitedByAvatarImageUrl, lastSentAt, expiresAt, approvalStatus, openCount }; gated to holders of the members.manage capability (invite emails are PII) — anyone else gets [] here, never a 403; absent entirely when ?include=invited is not passed',
    },
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/teams/:teamId',
    description:
      'Update team. User mode requires the teams.manage capability, resolved over the union of the org-role and team-role grants (org_features.role_grants); under the default table that is an org OR team owner/admin.',
    auth: 'domain hash bearer token',
    body: {
      name: 'string (optional)',
      'slug?': 'string — optional custom team slug; omitted leaves the current slug unchanged',
      description: 'string (optional)',
      'joinPolicy?':
        'string — INVITE_ONLY (default) | APPROVED_DOMAIN | REQUEST_TO_JOIN | OPEN_TO_ORG | HIDDEN; owner/admin only, omitted leaves the current policy unchanged',
      'icon_url?':
        'string | null — external HTTPS URL only, max 2048 chars; owner/admin only; omitted leaves the current icon unchanged, null clears it; non-https/oversized/invalid rejected with a generic error',
    },
    response: {
      slug: 'string — unique team slug within the organisation',
      iconUrl: 'string | null — echoed on every team read/write',
      avatarImageUrl:
        'string — always-resolving team avatar image URL (Docs/Auth/avatars.md §11)',
    },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId',
    description:
      'Delete team. Same teams.manage gate as the PUT. The organisation default team cannot be deleted.',
    auth: 'domain hash bearer token',
  },
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/join',
    description:
      "Self-join a team whose joinPolicy is OPEN_TO_ORG (caller must be an ACTIVE member of the team's org); reactivates a previously removed/deactivated membership instead of duplicating it",
    auth: 'domain hash bearer token + access token (X-UOA-Access-Token header)',
    response: {
      200: 'team member record',
      400: 'generic error — team not found, policy is not OPEN_TO_ORG, or already an active member',
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
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId',
    description:
      'Revoke a pending invitation (sent or still awaiting member-invite approval): the invite row is kept with status "revoked", outstanding emailed tokens are consumed, and the invite link refuses acceptance. Idempotent — revoking an already-revoked (or declined) invitation succeeds. User mode: a holder of the members.manage capability (org/team owner/admin under the default grant table) or the original inviter. Backend mode (header omitted): requires org_features.backend_org_management; audited with actor_user_id null + uoa_actor { via: "domain_backend" }.',
    auth: 'domain hash bearer token; access token (X-UOA-Access-Token header) optional — omit for backend mode',
    response: {
      200: '{ ok: true } (also for an already-revoked invitation)',
      403: 'caller holds neither members.manage in this workspace nor authorship of the invitation',
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
  {
    method: 'POST',
    path: '/org/organisations/:orgId/teams/:teamId/members',
    description:
      'Add team member. User mode requires the members.manage capability, resolved over the union of the org-role and team-role grants (org_features.role_grants); under the default table that is an org OR team owner/admin — a team admin can administer their own roster without org standing.',
    auth: 'domain hash bearer token',
    body: {
      user_id: 'string (required)',
      team_role:
        'string (optional, default "member") — validated against org_features.team_roles, this domain\'s configured team-role vocabulary',
    },
    response: {
      avatarImageUrl:
        "string — the member's avatar image URL, fetchable with the same domain hash bearer",
    },
  },
  {
    method: 'PUT',
    path: '/org/organisations/:orgId/teams/:teamId/members/:userId',
    description:
      'Change team member role. Same members.manage gate as adding a member.',
    auth: 'domain hash bearer token',
    body: {
      team_role:
        "string (required) — validated against org_features.team_roles, this domain's configured team-role vocabulary",
    },
    response: {
      avatarImageUrl:
        "string — the member's avatar image URL, fetchable with the same domain hash bearer",
    },
  },
  {
    method: 'DELETE',
    path: '/org/organisations/:orgId/teams/:teamId/members/:userId',
    description:
      'Remove team member (soft-remove; atomically revokes exact user+team refresh families across product domains without affecting other-team sessions). Same members.manage gate as adding a member.',
    auth: 'domain hash bearer token',
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/groups',
    description: 'List groups',
    auth: 'domain hash bearer token',
    query: {
      'limit?': 'number — page size, max 200',
      'cursor?': 'string — id of the last row of the previous page (from next_cursor)',
    },
    response: { data: 'array — group records', next_cursor: 'string | null' },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/groups/:groupId',
    description: 'Get group details',
    auth: 'domain hash bearer token',
    response: {
      members:
        'array — group members; each carries avatarImageUrl, fetchable with the same domain hash bearer',
    },
  },
];

// Every /org/* endpoint resolves its tenant from a strict domain query and is gated
// by the org feature flag, so the machine schema must advertise that uniformly rather
// than per-endpoint (issue #7 — integrators were blocked because `domain` and the
// X-UOA-Access-Token requirement were undocumented).
const ORG_DOMAIN_QUERY: Record<string, string> = {
  domain: 'string (required) — must match the config domain for domain-hash auth',
  config_url: 'string (required)',
};

const ORG_CONTRACT_NOTE =
  'Requires org_features.enabled=true (otherwise 404). Two calling modes. ' +
  'USER MODE: send X-UOA-Access-Token — the acting user is its `userId` claim, a new ' +
  'organisation is owned by that user (the body must not carry owner_user_id), and ' +
  'non-superusers can only create one when org_features.allow_user_create_org=true, else 403 ' +
  'ORG_CREATION_NOT_ALLOWED. BACKEND MODE: omit X-UOA-Access-Token entirely — the domain ' +
  'pairing already on every /org route (domain-hash bearer + verified signed config + ?domain=) ' +
  'authorises the call, and there is no acting user, so per-user org/team role checks do not ' +
  'apply. Backend mode requires org_features.backend_org_management=true in the signed config; ' +
  'without it a missing token is still 401 MISSING_ACCESS_TOKEN. Backend mode never crosses ' +
  'domains: the call binds to the VERIFIED config domain (a differing ?domain= is 400 ' +
  'DOMAIN_MISMATCH) and an :orgId belonging to another domain is 404. Where a route needs to ' +
  'name a user it takes one explicitly (owner_user_id on POST /org/organisations, userId on the ' +
  'member routes). GET /org/me and POST /org/organisations/:orgId/teams/:teamId/join are about ' +
  'the acting user and stay user-mode only (401 without a token). Backend-mode mutations are ' +
  'recorded in the org audit log with actor_user_id null and metadata.uoa_actor = ' +
  '{ via: "domain_backend", source_domain }. ' +
  'GET /org/organisations is BACKEND-ONLY: it lists a whole domain and has no user mode, so it ' +
  'refuses any present X-UOA-Access-Token with 401 ACCESS_TOKEN_NOT_ALLOWED (valid or blank ' +
  'alike) — omit the header, and use GET /org/me for a user\'s own workspaces. ' +
  IDENTITY_AVATAR_URL_NOTE;

function withOrgContract(list: EndpointSchema[]): EndpointSchema[] {
  return list.map((endpoint) => ({
    ...endpoint,
    query: { ...ORG_DOMAIN_QUERY, ...endpoint.query },
    notes: endpoint.notes ?? ORG_CONTRACT_NOTE,
  }));
}

export const endpoints: EndpointSchema[] = [
  ...baseEndpoints,
  ...configDebugEndpoints,
  ...authEndpoints,
  ...billingEndpoints,
  ...appEndpoints,
  ...emailEndpoints,
  ...domainEndpoints,
  ...avatarEndpoints,
  ...withOrgContract(orgEndpoints),
  ...integrationsEndpoints,
  ...internalAdminEndpoints,
  ...oauthEndpoints,
  ...signatureEndpoints,
];
