ALTER TYPE "VerificationTokenType" ADD VALUE 'ACCOUNT_DELETION';

ALTER TABLE "users" ADD COLUMN "account_deletion_requested_at" TIMESTAMP(3);

CREATE INDEX "users_pending_account_deletion_idx" ON "users" ("account_deletion_requested_at", "id")
WHERE "account_deletion_requested_at" IS NOT NULL;
