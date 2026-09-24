SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TYPE "VerificationTokenType" ADD VALUE 'ACTION_VERIFICATION';
ALTER TABLE "verification_tokens" ADD COLUMN "action_digest" TEXT;
