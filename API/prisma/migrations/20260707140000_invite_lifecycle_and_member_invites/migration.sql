-- Phase 4: invite lifecycle (expiry + approval) + member-initiated invites.
-- See Docs/plans/2026-07-07-slack-style-login-and-membership.md (§4.6, §4.7) and
-- Docs/api-2.0-implementation-plan.md style phase notes. Additive and behaviour-preserving via the
-- backfills below — no existing invite is instantly "expired" and no existing approved-domain
-- auto-enrolment is disabled by the join-policy gate this phase wires up in application code.

-- CreateEnum
CREATE TYPE "InviteApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'DENIED');

-- AlterTable: organisations — member-initiated invite policy (§4.7). Default "allowed" matches
-- current behaviour (any active member/backend caller may invite).
ALTER TABLE "organisations" ADD COLUMN     "member_invites" TEXT NOT NULL DEFAULT 'allowed';

-- AlterTable: team_invites — invite-level expiry + approval workflow (§4.7).
ALTER TABLE "team_invites" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "approval_status" "InviteApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "requested_by_user_id" TEXT;

-- ---------------------------------------------------------------------------
-- Backfill (CRITICAL — non-breaking, design §4.6/§4.7):
--
--   1. Existing pending invites get a 30-day expiry window measured from their last send, so the
--      new expiry gate (Phase 4 Task 3) does not instantly mark long-lived pending invites as
--      "expired". Resolved invites (accepted/declined/revoked) are left with a null expiresAt —
--      their derived status does not consult expiresAt once already resolved.
--   2. Teams that already rely on approved-domain auto-join (non-empty allowedEmailDomains) are
--      marked APPROVED_DOMAIN so the Phase 4 Task 2 join-policy gate does not disable their existing
--      auto-enrolment. Only teams still at the INVITE_ONLY default are touched — an operator who
--      already chose a different policy is left alone.
-- ---------------------------------------------------------------------------
UPDATE "team_invites" SET "expires_at" = "last_sent_at" + INTERVAL '30 days'
  WHERE "expires_at" IS NULL AND "accepted_at" IS NULL AND "declined_at" IS NULL AND "revoked_at" IS NULL;

UPDATE "teams" SET "join_policy" = 'APPROVED_DOMAIN'
  WHERE "join_policy" = 'INVITE_ONLY' AND cardinality("allowed_email_domains") > 0;
