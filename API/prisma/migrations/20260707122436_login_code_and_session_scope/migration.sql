-- Phase 3a: backend foundation for email-code login + workspace-scoped sessions.
-- See Docs/plans/2026-07-07-slack-style-login-and-membership.md (§4.3, §4.4, §5, §7 steps 3-4).
-- Additive and dormant: nothing populates the new columns yet, and LOGIN_CODE is an unused enum
-- value until Phase 3b wires the email-code flow. Zero runtime behaviour change.

-- AlterEnum
ALTER TYPE "VerificationTokenType" ADD VALUE 'LOGIN_CODE';

-- AlterTable
ALTER TABLE "authorization_codes" ADD COLUMN     "org_id" TEXT,
ADD COLUMN     "team_id" TEXT;

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "org_id" TEXT,
ADD COLUMN     "team_id" TEXT;

-- AlterTable
ALTER TABLE "verification_tokens" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0;
