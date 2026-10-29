SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE TABLE "facebook_email_proofs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" CITEXT NOT NULL,
  "provider_subject" TEXT NOT NULL,
  "name" TEXT,
  "avatar_url" TEXT,
  "state_json" TEXT NOT NULL,
  "completion_state_jwt" TEXT,
  "invite_token" TEXT,
  "browser_hash" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 5),
  "verified_at" TIMESTAMP(3),
  "used_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("used_at" IS NULL OR "verified_at" IS NOT NULL)
);
CREATE INDEX "facebook_email_proofs_expires_at_idx" ON "facebook_email_proofs" ("expires_at");
ALTER TABLE "facebook_email_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "facebook_email_proofs" FORCE ROW LEVEL SECURITY;
CREATE POLICY facebook_email_proofs_deny_app ON "facebook_email_proofs"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
REVOKE ALL ON "facebook_email_proofs" FROM uoa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "facebook_email_proofs" TO uoa_admin;
