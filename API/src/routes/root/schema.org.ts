import type { EndpointSchema } from './schema.js';

// The organisation object, its member roster, and the team objects themselves.
// Split out of schema.ts alongside schema.org-invitations.ts; the published /api
// order is the concatenation in schema.ts, so entries never move between arrays.
export const orgEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/org/me',
    description: 'Current user org context and complete authorized team directory',
    auth: 'domain hash bearer token plus exactly one user credential: X-UOA-Access-Token or X-UOA-Subject-Assertion',
    query: { config_url: 'string (required)' },
    response: {
      org: 'object | absent — live legacy org context plus the directory fields below. Normally anchored to the active same-domain organisation. For an `all_active_memberships` product whose selected team belongs to another domain, it is anchored to the token’s exact `active.orgId` after that organisation and the product policy are revalidated live. It remains absent when neither live context exists; an unscoped token never causes an arbitrary cross-domain org to be synthesized.',
      'org.teams':
        'array — one entry per ACTIVE team membership on this domain, or every active membership when this product is explicitly mapped to `all_active_memberships`: { teamId, orgId, name, slug, orgName, iconUrl, avatarImageUrl, role, lastLoginAt }. Each entry carries its own orgId/orgName; do not assume it belongs to the singular legacy org.org_id. avatarImageUrl is the public /teams/:teamId/avatar form (never null, no credential needed). Entries are ordered lastLoginAt DESC with nulls last, then name ASC (the sidebar order). Cross-product entries have null `lastLoginAt`.',
      'org.pending_invites':
        "array — the caller's pending invites on this domain: { inviteId, orgId, teamId, teamName, invitedBy, expiresAt }. orgId identifies the organisation to select after backend acceptance.",
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
      'Create organisation owned by the calling user (X-UOA-Access-Token). Non-superusers also require org_features.allow_user_create_org=true, else 403 ORG_CREATION_NOT_ALLOWED. In backend mode (no user credential) the body must carry owner_user_id instead and allow_user_create_org does not apply. The response is the organisation record plus defaultTeam: the "General" team created in the same transaction, with the owner already an ACTIVE member of it. Use defaultTeam.id to address the new team immediately — no follow-up read is needed, and none is possible with a subject assertion, which must already name the org and team it acts on.',
    auth: 'domain hash bearer token + X-UOA-Access-Token header (the new org owner), or backend mode',
    body: {
      name: 'string (required, 1-100)',
      'owner_user_id?':
        'string — backend mode only, and required there; rejected with 400 OWNER_NOT_ALLOWED alongside a user credential',
    },
    response: {
      '…': 'organisation record fields (id, domain, name, slug, ownerId, memberInvites, iconUrl, createdAt, updatedAt)',
      defaultTeam:
        'object — the full team record of the auto-created default team (isDefault true)',
    },
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
    description:
      'Stateless organisation roster. Every row is an exact organisation membership plus its scoped UOA identity. Email is returned only when the caller holds members.manage; permissions are action-specific verdicts, never a generic manager flag.',
    auth: 'domain hash bearer token',
    query: {
      'status?': 'string — ACTIVE (default) | DEACTIVATED | REMOVED | all',
      'limit?': 'number — page size, max 200',
      'direction?': 'forward (default) | backward',
      'cursor?': 'opaque signed keyset cursor from meta.nextCursor or meta.prevCursor',
    },
    response: {
      data: 'array — { id, orgId, subject, userId (legacy alias), role, status, identity { displayName, avatarImageUrl, email? }, avatarImageUrl, createdAt, updatedAt }; email is omitted without members.manage',
      total: 'number — count for the selected status filter',
      meta: 'object — { hasMore, nextCursor, prevCursor }',
      next_cursor: 'string | null — compatibility alias for meta.nextCursor',
      permissions:
        'object — { addMember, changeMemberRole, removeMember, deactivateMember, reactivateMember, viewMemberEmail }; each is a live caller verdict',
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
    method: 'GET',
    path: '/org/organisations/:orgId/members/:userId/workspaces',
    description:
      'List the selected member\'s editable workspace access. The result contains only teams where the caller currently holds members.manage; it never exposes or changes memberships outside that scope.',
    auth: 'domain hash bearer token',
    response: {
      data: 'array — { id, name, slug, avatarImageUrl, hasAccess }; a team is a workspace',
      permissions: 'object — { changeWorkspaceAccess }; live caller verdict',
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
      'Remove organisation member (soft-remove: status becomes REMOVED; atomically revokes exact user+org refresh families across product domains plus legacy sessions on this domain). User mode requires the members.manage capability at ORG scope; removing an owner additionally requires the actor to BE an owner.',
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
      'join_creator?':
        'boolean (default false) — add the acting user to the new team as its owner, in the same transaction. Set this when a person is creating their own team: every entry check asks for an ACTIVE TeamMember, so without it they create a team they cannot open. Leave it false when a backend is provisioning teams for other people. Idempotent (upsert), and ignored in backend mode, which has no acting user.',
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
      avatarImageUrl: 'string — always-resolving team avatar image URL (Docs/Auth/avatars.md §11)',
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
];

export const orgTeamMemberEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/members',
    description:
      'Stateless team roster. Supports lifecycle status filters and action-specific caller permissions. Email is returned only to members.manage holders (or the trusted backend in backend mode).',
    auth: 'domain hash bearer token',
    query: {
      'status?': 'string — ACTIVE (default) | DEACTIVATED | REMOVED | all',
      'limit?': 'number — page size, max 200',
      'direction?': 'forward (default) | backward',
      'cursor?': 'opaque signed keyset cursor from meta.nextCursor or meta.prevCursor',
    },
    response: {
      data: 'array — { id, teamId, subject, userId (legacy alias), role, teamRole, status, identity { displayName, avatarImageUrl, email? }, avatarImageUrl, createdAt, updatedAt }',
      total: 'number — count for the selected status filter',
      meta: 'object — { hasMore, nextCursor, prevCursor }',
      next_cursor: 'string | null — compatibility alias for meta.nextCursor',
      permissions:
        'object — { addMember, changeMemberRole, removeMember, viewMemberEmail, searchMemberCandidates }; each is a live caller verdict',
    },
  },
  {
    method: 'GET',
    path: '/org/organisations/:orgId/teams/:teamId/members/candidates',
    description:
      'Bounded, manager-only debounced candidate search for adding a member to this exact team. Searches ACTIVE members of this exact organisation only and excludes users already ACTIVE in the team; it is never a domain-wide user lookup.',
    auth: 'domain hash bearer token',
    query: {
      q: 'string (required, 1-100 characters) — server-side display-name or email match',
      'limit?': 'number — candidate count, default 20, max 50',
      'direction?': 'forward (default) | backward',
      'cursor?': 'opaque signed keyset cursor from meta.nextCursor or meta.prevCursor',
    },
    response: {
      data: 'array — { subject, userId, orgRole, identity { displayName, avatarImageUrl, email }, avatarImageUrl }; email is safe here because members.manage is required',
      total: 'number — count for this exact q and eligible-team filter',
      meta: 'object — { hasMore, nextCursor, prevCursor }',
      permissions: 'object — { addMember, searchMemberCandidates }',
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
    description: 'Change team member role. Same members.manage gate as adding a member.',
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
];

export const orgGroupEndpoints: EndpointSchema[] = [
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
