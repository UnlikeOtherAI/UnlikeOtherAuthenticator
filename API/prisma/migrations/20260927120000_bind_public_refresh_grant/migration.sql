-- Registered native-app clients of the public OAuth profile receive rotating refresh tokens.
-- Bind each public family to the credential epoch (users.token_version) of its originating
-- authorization code and to the exact granted scope and RFC 8707 resource, so rotation can never
-- widen access and any credential or session revocation ends the family. Confidential
-- /auth/token families leave all three NULL; existing rows are unaffected.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Nullable columns without defaults are a catalog-only change: no table rewrite.
ALTER TABLE "refresh_tokens"
ADD COLUMN "credential_epoch" INTEGER,
ADD COLUMN "oauth_scope" TEXT,
ADD COLUMN "resource" TEXT;

-- NOT VALID: enforced on every new write without scanning history under the migration's lock
-- (every existing row is NULL and therefore satisfies it anyway).
ALTER TABLE "refresh_tokens"
ADD CONSTRAINT "refresh_tokens_credential_epoch_check"
CHECK ("credential_epoch" IS NULL OR "credential_epoch" >= 0) NOT VALID;
