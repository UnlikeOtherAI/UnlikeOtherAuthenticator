export const llmRostersMarkdown = `### 4.7c Member rosters and team-add candidates

Use the roster endpoints for a members page; do not build a local copy of UOA
identity or membership data.

- \`GET /org/organisations/:orgId/members\` is the organisation roster.
- \`GET /org/organisations/:orgId/teams/:teamId/members\` is the team roster.

Both accept \`status=ACTIVE|DEACTIVATED|REMOVED|all\` (default \`ACTIVE\`),
\`limit\` (maximum 200), \`direction=forward|backward\` (default \`forward\`),
and an **opaque** \`cursor\`. They return this common envelope:

\`\`\`json
{
  "data": [{
    "subject": "uoa_user_…",
    "role": "member",
    "status": "ACTIVE",
    "identity": { "displayName": "Ada Lovelace", "avatarImageUrl": "…" }
  }],
  "total": 42,
  "meta": {
    "hasMore": true,
    "nextCursor": "opaque…",
    "prevCursor": null
  },
  "permissions": {
    "addMember": false,
    "changeMemberRole": false,
    "removeMember": false
  }
}
\`\`\`

Treat \`subject\` as the stable UOA user reference. \`userId\` remains as a
legacy alias. Render \`identity.displayName\` and \`identity.avatarImageUrl\`;
do not infer a person from a role. \`identity.email\` is deliberately absent
unless the caller holds \`members.manage\` at the applicable scope. Backend mode
(no \`X-UOA-Access-Token\`) remains the tenant authority and receives the same
full verdicts and email visibility as existing mutation routes.

Use \`meta.nextCursor\` with \`direction=forward\` and \`meta.prevCursor\` with
\`direction=backward\`; never decode, construct, or persist cursor internals.
\`next_cursor\` is retained only as a compatibility alias for \`meta.nextCursor\`.

The \`permissions\` object reports individual action verdicts rather than an
overbroad \`isManager\` flag. Respect the relevant action key when deciding
whether to show a control; UOA still reauthorizes the eventual mutation.

To power a debounced Add member picker, call
\`GET /org/organisations/:orgId/teams/:teamId/members/candidates?q=…\`.
\`q\` is required, limited to 100 characters, and matched server-side against
ACTIVE members of that organisation only. Results are cursor-paged with the
same meta contract, capped at 50 per page, and exclude users who are already
ACTIVE members of the target team. The endpoint itself
requires \`members.manage\`; it returns no invitation feed and does not search a
domain-wide user directory.

When an organisation manager opens a member, call
\`GET /org/organisations/:orgId/members/:userId/teams\`. Its rows are the
editable team memberships for that exact person, and \`hasAccess\` is the
live membership state. The feed contains only teams
where the caller currently holds \`members.manage\`; do not infer access to, or
attempt to change, a team omitted from it. Add or remove a selected team
through that exact team's existing member endpoints, which re-authorize each
write.

For the Pending invitations tab, use
\`GET /org/organisations/:orgId/member-invitations\`. This is a separate,
actionable \`TeamInvite\` feed, not
\`GET /org/organisations/:orgId/invitations?approval=pending\` (the owner-only
approval work queue). Every invitation row contains its explicit target team.
The feed is cursor-paged with the same \`meta\` envelope and returns only teams
where the caller currently holds \`members.manage\`.
For a team Members page, use the same contract at
\`GET /org/organisations/:orgId/teams/:teamId/member-invitations\`.

Before creating an organisation-level invitation, obtain the explicit target
team from \`GET /org/organisations/:orgId/member-invitation-targets\`; it has
the same cursor envelope and only includes teams the caller can manage. Submit
the selected id to the existing exact-team invitation endpoint. Do not reuse a
product session's active team as a silent target.`;
