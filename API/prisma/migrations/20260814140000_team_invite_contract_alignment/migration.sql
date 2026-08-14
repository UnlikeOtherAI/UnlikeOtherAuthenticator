-- Abort fast behind live traffic (Docs/deploy.md): never queue behind a lock.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Phase A2.1a follow-up (contract alignment):
--
--   1. team_invite_deliveries.generation gains the database default 0 that
--      Prisma has always declared (@default(0)). The foundation migration
--      created the column NOT NULL with no default, so raw inserts without a
--      generation failed despite the Prisma contract promising one.
--
--   2. Legacy actionable owner-role invitations are terminalized. The A2.1a
--      role CHECK only permits member/admin, so a deploy that left those rows
--      actionable would make them un-actionable at the database boundary the
--      moment anything touched them. Revoking them now (current actionable
--      predicate: unaccepted, undeclined, unrevoked, approval not DENIED)
--      keeps them in the same terminal state every other revoked invite uses;
--      accepted historical owner rows are deliberately untouched (their
--      acceptance is fact).
--      The NOT VALID `team_invites_team_role_check` from A2.1a still fires on
--      any UPDATE of an owner row, so the rail is dropped, the cleanup runs,
--      and the identical NOT VALID check is re-added (metadata-only, no table
--      scan) — the end-state invariant is unchanged.
--
-- All DDL is current_schema()-portable (no hardcoded `public`) so the real
-- migration suite can apply it into an isolated test schema.

ALTER TABLE "team_invite_deliveries"
  ALTER COLUMN "generation" SET DEFAULT 0;

ALTER TABLE "team_invites"
  DROP CONSTRAINT "team_invites_team_role_check";

UPDATE "team_invites"
SET "revoked_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "team_role" = 'owner'
  AND "accepted_at" IS NULL
  AND "declined_at" IS NULL
  AND "revoked_at" IS NULL
  AND "approval_status" <> 'DENIED';

ALTER TABLE "team_invites"
  ADD CONSTRAINT "team_invites_team_role_check"
    CHECK ("team_role" IN ('member', 'admin')) NOT VALID;
