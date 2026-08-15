-- Invitation revocation (extends design §4.7):
-- `revoked_reason` records WHY `revoked_at` was set. Every pre-existing revoked row was revoked
-- implicitly by being replaced with a newer invite for the same email (the only writer of
-- `revoked_at` until now), so the backfill labels them REPLACED. The new explicit
-- DELETE /org/organisations/:orgId/teams/:teamId/invitations/:inviteId endpoint writes REVOKED.
CREATE TYPE "InviteRevokedReason" AS ENUM ('REPLACED', 'REVOKED');

ALTER TABLE "team_invites"
  ADD COLUMN "revoked_reason" "InviteRevokedReason";

UPDATE "team_invites"
SET "revoked_reason" = 'REPLACED'
WHERE "revoked_at" IS NOT NULL
  AND "revoked_reason" IS NULL;
