# U1 canonical writer inventory — 2026-10-14

Draft source inventory: 113 direct Prisma writes in 52 named functions.
All runtime/upgrade/race verification remains open. This is not a completed U1
acceptance report and does not authorize a cached consumer cutover.

The durable source guard is `API/tests/unit/directory-writer-coverage.test.ts`.
It rejects new unwrapped canonical writes, restricts the initial-identity and
private-factor exceptions, checks the private helper call paths, and flags new
raw canonical/dynamic writers. It cannot prove affected-scope completeness, SQL
permissions, transaction ordering, application authorization or runtime behavior.

| Source | Symbol | Direct writes | Draft boundary / exception | Runtime verified |
| --- | --- | --- | --- | --- |
| [access-request.service.base.ts](../../API/src/services/access-request.service.base.ts) | `ensureUserAssignedToConfiguredAccessTarget` | `orgMember.create`, `teamMember.create` | withDirectoryMutation | [ ] |
| [auth-reset-password.service.ts](../../API/src/services/auth-reset-password.service.ts) | `resetPasswordWithToken` | `user.update` | Password-only write; same transaction calls the epoch revocation seam. | [ ] |
| [auth-verify-email.service.ts](../../API/src/services/auth-verify-email.service.ts) | `verifyEmailToken` | `user.updateMany` ×2, `user.create` ×2 | withDirectoryUserMutation; Initial unbound identities and verified password setup; name writes use the user seam and accepted membership/epoch writes use their seams. | [ ] |
| [avatar.service.ts](../../API/src/services/avatar.service.ts) | `deleteAvatar` | `userAvatar.deleteMany` | withDirectoryUserMutation | [ ] |
| [avatar.service.ts](../../API/src/services/avatar.service.ts) | `uploadAvatar` | `userAvatar.upsert` | withDirectoryUserMutation | [ ] |
| [entity-deletion-job.service.ts](../../API/src/services/entity-deletion-job.service.ts) | `markDeleting` | `user.update` ×2, `team.updateMany`, `organisation.update` | Private helper called only inside beginEntityDeletion lifecycle seam. | [ ] |
| [entity-deletion-sweep.service.ts](../../API/src/services/entity-deletion-sweep.service.ts) | `eraseOperationalIdentity` | `userAvatar.deleteMany`, `groupMember.deleteMany`, `teamMember.deleteMany`, `orgMember.deleteMany`, `user.update`, `user.delete` | withDirectoryLifecycleMutation | [ ] |
| [entity-deletion-sweep.service.ts](../../API/src/services/entity-deletion-sweep.service.ts) | `sweepDeletion` | `teamAvatar.deleteMany`, `teamMember.deleteMany`, `team.updateMany`, `team.update` ×2, `orgMember.deleteMany` ×2, `group.deleteMany`, `organisation.update` ×2, `team.delete`, `organisation.delete` | withDirectoryLifecycleMutation | [ ] |
| [group.service.groups.ts](../../API/src/services/group.service.groups.ts) | `createGroup` | `group.create` | withDirectoryMutation | [ ] |
| [group.service.groups.ts](../../API/src/services/group.service.groups.ts) | `deleteGroup` | `group.delete` | withDirectoryMutation | [ ] |
| [group.service.groups.ts](../../API/src/services/group.service.groups.ts) | `updateGroup` | `group.update` | withDirectoryMutation | [ ] |
| [group.service.members.ts](../../API/src/services/group.service.members.ts) | `addGroupMember` | `groupMember.create` | withDirectoryMembershipMutation | [ ] |
| [group.service.members.ts](../../API/src/services/group.service.members.ts) | `assignTeamToGroup` | `team.update` | withDirectoryMutation | [ ] |
| [group.service.members.ts](../../API/src/services/group.service.members.ts) | `removeGroupMember` | `groupMember.delete` | withDirectoryMembershipMutation | [ ] |
| [group.service.members.ts](../../API/src/services/group.service.members.ts) | `updateGroupMemberAdmin` | `groupMember.update` | withDirectoryMembershipMutation | [ ] |
| [internal-admin-lifecycle.service.ts](../../API/src/services/internal-admin-lifecycle.service.ts) | `revokeLifecycleSessions` | `user.update` | Epoch-only helper called inside lifecycle/markDeleting seams. | [ ] |
| [internal-admin-lifecycle.service.ts](../../API/src/services/internal-admin-lifecycle.service.ts) | `setEntityLifecycle` | `user.update`, `team.update`, `organisation.update` | withDirectoryLifecycleMutation | [ ] |
| [internal-admin-team-members.service.ts](../../API/src/services/internal-admin-team-members.service.ts) | `addAdminUserToTeam` | `orgMember.upsert`, `teamMember.upsert` | withDirectoryMutation | [ ] |
| [internal-admin.service.organisations.ts](../../API/src/services/internal-admin.service.organisations.ts) | `createAdminOrganisation` | `organisation.create`, `team.create`, `orgMember.create`, `teamMember.create` | withDirectoryMutation | [ ] |
| [internal-admin.service.organisations.ts](../../API/src/services/internal-admin.service.organisations.ts) | `updateAdminOrganisation` | `organisation.update` | withDirectoryMutation | [ ] |
| [internal-admin.service.organisations.ts](../../API/src/services/internal-admin.service.organisations.ts) | `updateAdminTeam` | `team.update` | withDirectoryMutation | [ ] |
| [lifecycle-status.service.ts](../../API/src/services/lifecycle-status.service.ts) | `verifyLifecycleStatus` | `user.update` | Private TOTP replay counter; no directory profile/standing field. | [ ] |
| [org-placement.service.ts](../../API/src/services/org-placement.service.ts) | `autoCreatePersonalOrgForUser` | `organisation.create`, `team.create`, `orgMember.create`, `teamMember.create` | withDirectoryMutation | [ ] |
| [org-placement.service.ts](../../API/src/services/org-placement.service.ts) | `placeFromDomainMapping` | `orgMember.create`, `teamMember.create` | withDirectoryMutation | [ ] |
| [organisation.service.lifecycle.ts](../../API/src/services/organisation.service.lifecycle.ts) | `deactivateOrganisationMember` | `orgMember.update`, `teamMember.updateMany` | withDirectoryMutation | [ ] |
| [organisation.service.lifecycle.ts](../../API/src/services/organisation.service.lifecycle.ts) | `reactivateOrganisationMember` | `orgMember.update`, `teamMember.updateMany` | withDirectoryMembershipMutation | [ ] |
| [organisation.service.members.ts](../../API/src/services/organisation.service.members.ts) | `addOrganisationMember` | `orgMember.update`, `teamMember.update`, `teamMember.create` ×2, `orgMember.create` | withDirectoryMutation | [ ] |
| [organisation.service.members.ts](../../API/src/services/organisation.service.members.ts) | `changeOrganisationMemberRole` | `orgMember.update` | withDirectoryMembershipMutation | [ ] |
| [organisation.service.members.ts](../../API/src/services/organisation.service.members.ts) | `removeOrganisationMember` | `teamMember.updateMany`, `groupMember.deleteMany`, `orgMember.update` | withDirectoryMutation | [ ] |
| [organisation.service.organisation.ts](../../API/src/services/organisation.service.organisation.ts) | `createOrganisation` | `organisation.create`, `team.create`, `orgMember.create`, `teamMember.create` | withDirectoryMutation | [ ] |
| [organisation.service.organisation.ts](../../API/src/services/organisation.service.organisation.ts) | `updateOrganisation` | `organisation.update` | withDirectoryMutation | [ ] |
| [organisation.service.ownership.ts](../../API/src/services/organisation.service.ownership.ts) | `transferOrganisationOwnership` | `organisation.updateMany`, `orgMember.update` ×2 | withDirectoryMembershipMutation | [ ] |
| [profile.service.ts](../../API/src/services/profile.service.ts) | `readOrWriteProfile` | `user.update` | Private self helper: calls with a patch are inside the self-profile seam; two-argument calls are reads. | [ ] |
| [refresh-token-revocation.service.ts](../../API/src/services/refresh-token-revocation.service.ts) | `bumpUserTokenVersion` | `user.update` | withDirectoryUserMutation | [ ] |
| [social-login.service.ts](../../API/src/services/social/social-login.service.ts) | `loginWithSocialProfile` | `user.update`, `user.create` | withDirectoryUserMutation; Initial unbound identity has no org standing; existing profile writes use the user seam and placement reuses the transaction. | [ ] |
| [team-avatar.service.ts](../../API/src/services/team-avatar.service.ts) | `deleteTeamAvatar` | `teamAvatar.deleteMany` | withDirectoryMutation | [ ] |
| [team-avatar.service.ts](../../API/src/services/team-avatar.service.ts) | `uploadTeamAvatar` | `teamAvatar.upsert` | withDirectoryMutation | [ ] |
| [team-invite-link.redemption.ts](../../API/src/services/team-invite-link.redemption.ts) | `redeemTeamInviteLink` | `orgMember.create`, `teamMember.create`, `teamMember.update` | withDirectoryMutation | [ ] |
| [team-invite.service.acceptance.ts](../../API/src/services/team-invite.service.acceptance.ts) | `acceptTeamInviteWithinTransaction` | `user.updateMany`, `orgMember.create`, `orgMember.update`, `teamMember.create`, `teamMember.update` | withDirectoryMutation | [ ] |
| [team.service.members.ts](../../API/src/services/team.service.members.ts) | `addTeamMember` | `teamMember.update`, `teamMember.create` | withDirectoryMembershipMutation | [ ] |
| [team.service.members.ts](../../API/src/services/team.service.members.ts) | `changeTeamMemberRole` | `teamMember.update` | withDirectoryMembershipMutation | [ ] |
| [team.service.members.ts](../../API/src/services/team.service.members.ts) | `removeTeamMember` | `teamMember.update` | withDirectoryMutation | [ ] |
| [team.service.self-join.ts](../../API/src/services/team.service.self-join.ts) | `selfJoinTeam` | `teamMember.update`, `teamMember.create` | withDirectoryMembershipMutation | [ ] |
| [team.service.teams.ts](../../API/src/services/team.service.teams.ts) | `createTeam` | `team.create`, `teamMember.upsert` | withDirectoryMembershipMutation | [ ] |
| [team.service.teams.ts](../../API/src/services/team.service.teams.ts) | `updateTeam` | `team.update` | withDirectoryMutation | [ ] |
| [twofactor-disable.service.ts](../../API/src/services/twofactor-disable.service.ts) | `clearTwoFactor` | `user.updateMany` | Private factor state; caller revokes all sessions through the epoch seam in the same transaction. | [ ] |
| [twofactor-disable.service.ts](../../API/src/services/twofactor-disable.service.ts) | `resetTwoFactor` | `user.updateMany` | Private factor state; caller revokes all sessions through the epoch seam in the same transaction. | [ ] |
| [twofactor-enroll.service.ts](../../API/src/services/twofactor-enroll.service.ts) | `enrollTwoFactorForUser` | `user.updateMany` | Private factor state, excluded from background directory payloads. | [ ] |
| [twofactor-login.service.ts](../../API/src/services/twofactor-login.service.ts) | `verifyTwoFactorForLogin` | `user.updateMany` | Private TOTP replay counter, excluded from directory payloads. | [ ] |
| [twofactor-reset.service.ts](../../API/src/services/twofactor-reset.service.ts) | `resetTwoFaWithToken` | `user.update` | Private factor state; same transaction calls the epoch revocation seam. | [ ] |
| [user-team-requirement.service.ts](../../API/src/services/user-team-requirement.service.ts) | `createPersonalOrgAndTeam` | `organisation.create`, `team.create`, `orgMember.create`, `teamMember.create` | withDirectoryMutation | [ ] |
| [user-team-requirement.service.ts](../../API/src/services/user-team-requirement.service.ts) | `createPersonalTeamForExistingOrg` | `team.create`, `teamMember.create`, `orgMember.update` | withDirectoryMutation | [ ] |

The additional raw writer is `identity-operational-sweep.service.ts` →
`scrubOperatorAttribution`: one trusted table loop updates allowed_emails on
organisations, teams and client_domains. Final erasure selects its exclusive
policy fence before actor/user locks and resolves all affected org IDs before
mutation. Its only caller is inside the prepared user-erasure lifecycle seam.
Audit-history cursor updates are attribution/privacy work, not canonical profile
or membership authority. Database migrations establish a baseline before U1/U2
consumer cutover; they are not reconstructed live mutation history.

- [ ] Real PostgreSQL event coverage for each writer family.
- [ ] Rollback, sorted multi-org locking and concurrent commit order.
- [ ] Forced-RLS tenant boundary, revoked grants and real upgrade fixtures.
- [ ] Deletion retry preserves exact prior provenance and final terminal event.
- [ ] Erase-reference scrubs previous outbox subjects, including policy-only orgs.
- [ ] Auth/profile/member/first-placement rendered flows and compiled package checks.

## 2026-10-15 runtime evidence and discovered race

cb7e0697 proves global profile/avatar create/delete/epoch invalidations across two
orgs, all7group CRUD/member/team-assignment commits with ordered events under real
uoa_app, and rollback of canonical group/revision/outbox. It exposes a post-removal
group insertion race; the source guard could not detect it. A post-lock admission
check and schema migration207 now address that path, with fresh-upgrade and retained
failed-record repair tests pending. The113direct source writes are unchanged;
the migration's canonical group cleanup is additional SQL work requiring its own
runtime proof. This is not full113-writer acceptance.
