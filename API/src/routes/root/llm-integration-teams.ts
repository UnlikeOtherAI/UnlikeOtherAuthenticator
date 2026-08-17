// Sections 4.7a and 4.7b of the /llm guide: team join policies, the invitation
// lifecycle, the sidebar workspace stack, the "Invited" tab and workspace icons.
export const llmTeamsInvitationsMarkdown = `### 4.7a Team join policies + member-initiated invites (Phase 4)

Every \`Team\` has a \`joinPolicy\`: \`INVITE_ONLY\` (default) | \`APPROVED_DOMAIN\` | \`REQUEST_TO_JOIN\` | \`OPEN_TO_ORG\` | \`HIDDEN\`. The policy **gates** the existing join mechanisms rather than replacing them:

- **Auto-enrolment** via \`access_requests.auto_grant_domains\` only auto-adds a user when the configured target team's \`joinPolicy\` is \`APPROVED_DOMAIN\`.
- **Request-to-join** (\`access_requests.enabled\`) only accepts a request when the target team's \`joinPolicy\` is \`REQUEST_TO_JOIN\`; any other policy fails the login with a generic error when \`request_access=true\` is set.
- **Self-join** — \`POST /org/organisations/:orgId/teams/:teamId/join\` (access token required) — succeeds only when the team's \`joinPolicy\` is \`OPEN_TO_ORG\` and the caller is an ACTIVE member of the team's org. Reactivates a previously removed/deactivated row instead of duplicating it.
- **HIDDEN** teams are excluded from \`GET /org/organisations/:orgId/teams\` for callers who are not already an ACTIVE member of that team.
- Set the policy with \`PUT /org/organisations/:orgId/teams/:teamId\` (\`{ "joinPolicy": "OPEN_TO_ORG" }\`, owner/admin only).

Team invites now carry an \`expiresAt\` (30 days from send/resend — resending refreshes it) and an \`approvalStatus\`: \`not_required\` | \`pending\` | \`approved\` | \`denied\`. The derived invite \`status\` gains \`expired\` and \`revoked\` alongside \`pending | accepted | declined | replaced\` (\`replaced\` = superseded by a newer invite for the same email; \`revoked\` = explicitly cancelled); an expired, revoked, or not-yet-approved invite cannot be accepted and is excluded from the workspace chooser / \`firstLogin.pending_invites\`.

**One live invitation per address.** At most one *actionable* invitation — not accepted, not declined, not revoked, and approval not \`denied\` — exists per \`(team, lowercased email)\`, enforced by a partial unique index rather than by application checks alone, so two concurrent invites to the same address can no longer both land. Inviting an address that already holds one replaces it: the previous invitation is revoked as \`replaced\` and the result is \`resent_existing\`. Terminal invitations are untouched and accumulate as history.

**Roles an invitation may grant.** Any role in the domain's \`org_features.team_roles\` vocabulary (default \`owner | admin | member\`) **except \`owner\`**. Ownership of a team comes from direct membership management, never from an emailed invitation, so an \`owner\` grant is rejected with the generic \`400\` on create and on resend, and by a database constraint underneath. A domain that defined its own roles invites into them normally — the rail names \`owner\` specifically, it is not a fixed \`member|admin\` list.

**Resending** (\`POST .../invitations/:inviteId/resend\`) requires an actionable invitation whose approval is settled. Accepted, declined, revoked, approval-denied, and still-awaiting-approval invitations all answer the generic \`400\`: a resend must not resurrect an invitation an administrator revoked, nor mail one nobody has approved. An *expired* invitation is still resendable — that is how it gets a fresh token and a fresh window.

Reading one invitation: \`GET /org/organisations/:orgId/teams/:teamId/invitations/:inviteId\` returns that single invitation in exactly the shape each entry of the list carries (derived \`status\`, \`approvalStatus\`, \`expiresAt\`, inviter, send/open and accepted/declined/revoked state, \`invitedByAvatarImageUrl\`/\`acceptedAvatarImageUrl\`) — so a caller holding an id can re-read one row instead of the whole team's invite history. Authorization is the list's: domain-hash + verified config + \`org_features\`, backend-mode capable. It is read-only — nothing is written and no audit row is produced. An unknown id, an invitation belonging to a foreign org/team, and an unknown org all answer the same generic \`404\`, so the endpoint is never an existence oracle. The org itself need not have been created on the calling product's domain — one organisation is usable from every UOA-integrated product, and the token's \`org\` claim plus live membership are the gate (backend mode stays origin-scoped).

Where the id comes from: the trusted-backend bulk call \`POST /org/organisations/:orgId/teams/:teamId/invitations\` answers \`{ "results": [...] }\` with one object per submitted email — \`{ email, status, invite? }\`. On \`invited\` and \`resent_existing\` rows the \`invite\` key is the full invitation record, so \`results[i].invite.id\` is the id of the invitation just created (or, for \`resent_existing\`, of the fresh invitation that superseded the previous one) and is what the by-id read, \`.../resend\`, and \`DELETE\` take. The \`already_member\`, \`existing_user\`, and \`conflict\` outcomes create no invitation and therefore carry \`email\` + \`status\` only, with no \`invite\` key. The member-initiated (\`X-UOA-Access-Token\`) variant returns \`{ "status": "ok" }\` and deliberately no id — revealing one would be enumeration.

Revoking an invitation: \`DELETE /org/organisations/:orgId/teams/:teamId/invitations/:inviteId\` cancels a pending invitation in either state — already emailed, or still awaiting member-invite approval. The row is kept (invite history is audit history) with \`status: "revoked"\`, outstanding emailed tokens are consumed, and the invite link's hosted landing page tells the recipient the invitation was revoked. In user mode the caller must be an org/team \`owner\`/\`admin\` or the invite's original inviter; backend mode follows the table above. Responses: \`200 { "ok": true }\` (idempotent — an already-revoked or declined invitation also answers \`200\`), \`409\` with code \`INVITATION_ALREADY_ACCEPTED\` once the invite has been accepted (remove the member instead), generic \`404\` for an unknown id or a foreign org/team.

Member-initiated invites: \`POST /org/organisations/:orgId/teams/:teamId/invitations\` accepts the same path used by the trusted backend bulk-invite call, but when called WITH an \`X-UOA-Access-Token\` header it becomes a single-invite, permission-gated call instead:

- Anyone holding \`members.manage\` in the workspace — org or team \`owner\`/\`admin\` under the default grant table: always allowed, sent immediately (\`approvalStatus: not_required\`).
- A plain ACTIVE team member: gated by the organisation's \`memberInvites\` setting (\`allowed\` default | \`admin_approval\` | \`disabled\`, set via \`PUT /org/organisations/:orgId\` \`{ "member_invites": "admin_approval" }\`). \`admin_approval\` creates the invite as \`pending\` and sends **no email** until an owner/admin approves it.
- A deactivated member, or a plain member when \`disabled\`, is rejected generically.
- The response is always \`{ "status": "ok" }\` regardless of outcome — whether the email already has an account is never revealed (no enumeration).

Owner/admin review the pending queue with \`GET /org/organisations/:orgId/invitations?approval=pending\`, then \`POST /org/organisations/:orgId/invitations/:inviteId/approve\` (sends the invite email) or \`.../deny\` (silent to the invitee, sends nothing).

### 4.7b Sidebar workspace stack, "Invited" tab, and workspace icons (gap-fix A, design §11.3–§11.5)

\`GET /org/me\` now returns two additive fields inside \`org\` alongside the existing \`org_id\`,
\`org_role\`, \`teams\`, \`team_roles\`, \`groups\` (unchanged — this is purely additive). For a
recognized \`all_active_memberships\` product with no same-domain organisation, the complete legacy
block is anchored to the access token's exact selected \`active.orgId\` after UOA revalidates that
organisation and the product policy live:

\`\`\`json
{
  "org": {
    "org_id": "org_…",
    "org_role": "admin",
    "teams": ["team_1", "team_2"],
    "team_roles": { "team_1": "owner", "team_2": "member" },
    "workspaces": [
      {
        "teamId": "team_1",
        "orgId": "org_…",
        "name": "Backend Team",
        "slug": "backend-team",
        "orgName": "Acme Inc",
        "iconUrl": "https://cdn.example.com/backend.png",
        "avatarImageUrl": "https://authentication.unlikeotherai.com/teams/team_1/avatar",
        "role": "owner",
        "lastLoginAt": "2026-07-01T12:00:00.000Z"
      },
      {
        "teamId": "team_2",
        "orgId": "org_…",
        "name": "Design",
        "slug": "design",
        "orgName": "Acme Inc",
        "iconUrl": null,
        "avatarImageUrl": "https://authentication.unlikeotherai.com/teams/team_2/avatar",
        "role": "member",
        "lastLoginAt": null
      }
    ],
    "pending_invites": [
      { "inviteId": "inv_…", "teamId": "team_3", "teamName": "Growth", "invitedBy": "Alice Admin", "expiresAt": "2026-08-01T00:00:00.000Z" }
    ]
  }
}
\`\`\`

- \`workspaces[]\` — one entry per ACTIVE team membership on this domain. When UOA's server-owned
  product policy is \`all_active_memberships\`, it instead contains the same complete active
  workspace directory as the hosted chooser. It is ordered \`lastLoginAt\` DESC with nulls last,
  then \`name\` ASC (this IS the sidebar order — render it as-is). \`lastLoginAt\` is \`null\` when
  the caller never opened a session scoped to that workspace; cross-product entries intentionally
  remain \`null\` because another product's session history is not exposed. Group by each entry's
  own \`orgId\`/\`orgName\`; the directory may span organisations and is not implicitly scoped by the
  singular legacy \`org_id\` field.
- \`avatarImageUrl\` — the public, credential-free \`<PUBLIC_BASE_URL>/teams/<teamId>/avatar\` form.
  It is never null and resolves uploaded image → proxied \`iconUrl\` → deterministic generated image,
  so a native or browser client renders this field directly instead of fetching \`iconUrl\` itself.
- \`pending_invites[]\` — the caller's own pending invites on this domain (same eligibility as the
  workspace chooser: unaccepted/undeclined/unrevoked, not expired, and not still awaiting
  member-invite approval).
- Render this straight into the Slack-style sidebar: active workspace highlighted (match
  \`active.teamId\` from the access-token claim, §4.2), the rest one click away via \`team_hint\` on
  \`/auth\`, invite cards for \`pending_invites\`.

**"Invited" tab** — \`GET /org/organisations/:orgId/teams/:teamId?include=invited\` (exact literal;
any other value for \`include\` is ignored, same as omitting it):

\`\`\`json
{
  "id": "team_1",
  "name": "Backend Team",
  "slug": "backend-team",
  "iconUrl": "https://cdn.example.com/backend.png",
  "members": [ { "userId": "user_…", "teamRole": "owner" } ],
  "invited": [
    {
      "inviteId": "inv_…",
      "email": "new.hire@acme.com",
      "inviteName": "New Hire",
      "teamRole": "member",
      "invitedByName": "Alice Admin",
      "invitedByEmail": "alice@acme.com",
      "lastSentAt": "2026-07-05T00:00:00.000Z",
      "expiresAt": "2026-08-04T00:00:00.000Z",
      "approvalStatus": "pending",
      "openCount": 0
    }
  ]
}
\`\`\`

- Without \`?include=invited\`, the response is byte-identical to before — no \`invited\` key at all.
- With it, \`invited\` is **always present** as an array. Unlike every other pending-invite surface,
  it INCLUDES \`approvalStatus: "pending"\` entries (an admin reviewing the tab must see invites still
  awaiting member-invite approval, §4.7a) — the field itself tells you which.
- \`invited\` is gated to an org **or** team \`owner\`/\`admin\` (invite emails are PII): a plain member
  gets \`invited: []\`, never a \`403\` — the rest of the team read is unaffected either way.

**Workspace icons** (design §11.3) — \`Team.iconUrl\` / \`Organisation.iconUrl\`, external URL only, no
local storage (brief §15). Set with the existing \`PUT\` endpoints:

\`\`\`jsonc
PUT /org/organisations/:orgId/teams/:teamId
{ "icon_url": "https://cdn.example.com/backend.png" }   // or "icon_url": null to clear
\`\`\`

Same body/response shape for \`PUT /org/organisations/:orgId\`. Rules, identical for both:

- \`icon_url\` omitted → unchanged. \`null\` → clears it. Otherwise must be an \`https:\` URL, max 2048
  characters — anything else (\`http:\`, a bare string, oversized) is rejected with the same generic
  \`400\` UOA uses everywhere else (no "must be https" specificity leaked back).
- Owner/admin only — the same authorization the \`PUT\` already enforced.
- \`iconUrl\` is echoed on every team/org read and write, the workspace chooser's \`teams[]\`, \`/org/me\`'s
  \`workspaces[]\`, and \`firstLogin.memberships.teams[]\` — one column, one field name, everywhere.`;
