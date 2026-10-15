export const llmGroupMembershipMarkdown = `## System-admin group mutations

Groups are feature-gated by the signed config and all writes require the current
admin-domain SUPERUSER bearer. Supply domain and config_url on each internal URL.
POST /internal/org/organisations/:orgId/groups creates a group; PUT/DELETE the same
path plus /:groupId updates/deletes it. POST .../groups/:groupId/members accepts
{userId,isAdmin?}; PUT .../members/:userId accepts {isAdmin}; DELETE removes that
membership. PUT .../teams/:teamId/group accepts {groupId:string|null}.

Group additions and admin-flag changes recheck exact organisation membership
under canonical user/directory locks. A missing/REMOVED membership or a
DELETING/DELETED subject is refused; the organisation must remain ACTIVE.
Re-add the person through the supported organisation/team admission flow first.
DEACTIVATED membership retains administrative metadata but confers no active
access. Cross-origin subjects use their canonical UOA identity, never a local
profile copy. Canonical writes, revisions and directory events commit together.
The database also rejects stale older-writer inserts; the forward migration
repairs orphaned/REMOVED group grants and records minimal directory invalidations.

`;
