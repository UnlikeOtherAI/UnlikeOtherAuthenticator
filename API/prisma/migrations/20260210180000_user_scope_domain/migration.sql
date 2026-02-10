-- Add per-domain user scope support.
--
-- We cannot keep a global UNIQUE(email) constraint because the same email may exist
-- on multiple domains when `user_scope` is "per_domain". Instead, we enforce uniqueness
-- via a derived `user_key`:
--   - global:      "<email>"
--   - per_domain:  "<domain>|<email>"

-- Add new columns (nullable initially for backfill).
ALTER TABLE "users" ADD COLUMN "domain" TEXT;
ALTER TABLE "users" ADD COLUMN "user_key" TEXT;

-- Backfill existing rows (all pre-existing users are treated as "global").
UPDATE "users" SET "user_key" = "email" WHERE "user_key" IS NULL;

-- Enforce not-null after backfill.
ALTER TABLE "users" ALTER COLUMN "user_key" SET NOT NULL;

-- Drop old global uniqueness constraint on email.
DROP INDEX "users_email_key";

-- New uniqueness constraint.
CREATE UNIQUE INDEX "users_user_key_key" ON "users"("user_key");

-- Useful query indexes.
CREATE INDEX "users_email_idx" ON "users"("email");
CREATE INDEX "users_domain_idx" ON "users"("domain");

