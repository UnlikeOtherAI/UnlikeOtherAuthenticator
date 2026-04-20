CREATE EXTENSION IF NOT EXISTS "citext";

ALTER TABLE "users"
ALTER COLUMN "email" TYPE CITEXT;

ALTER TABLE "users"
ADD COLUMN "2fa_last_accepted_counter" INTEGER;

CREATE INDEX "verification_tokens_user_id_idx" ON "verification_tokens"("user_id");

CREATE INDEX "access_requests_reviewed_by_user_id_idx" ON "access_requests"("reviewed_by_user_id");

-- TODO(VM5/M8): Add OrgEmailDomainRule.teamId and nullable-team partial unique
-- indexes when the org_email_domain_rules table exists in this schema.
