export const llmAutomaticMembershipMarkdown = `
### Automatic team membership (Nessie)

Nessie may call the narrow \`/org/automatic-membership/*\` contract only with a
dedicated \`automatic_membership\` app key bound to the \`nessie\` service. UOA
rejects every organisation without current direct Nessie service-access evidence.
The contract returns stable subjects, never emails; UOA validates current verified
identity data itself and grants only \`member\` roles, preserving stronger roles.
It creates absent memberships only: an existing DEACTIVATED or REMOVED membership
is reported as skipped and is never reactivated by a domain rule. Backfills use
opaque, snapshot-bound cursors; either snapshot conflict is an explicit signal to
restart safely because grants are idempotent.
The product's ordinary domain bearer, user profile cache, and billing app keys are
not valid credentials for this capability. See \`GET /api\` for each endpoint.

UOA Admin is also a first-class control plane. A UOA superuser can manage the
same rule state at \`/internal/admin/organisations/:orgId/automatic-membership\`
or its exact-team counterpart. Those browser-facing routes never expose Nessie's
bridge credential: UOA binds the admin's stable subject, exact organisation/team,
and requested action into a short-timeout, HMAC-authenticated server request to
Nessie. The read response contains only rules, DNS instructions, aggregate
backfill status/failures, and bounded audit history — never a broad directory of
identities matching the domain.
`;
