-- Preserve the remaining exact-flow state needed by config-JWT and public OAuth
-- signing continuations. Additive defaults keep any pre-existing local rows valid.

ALTER TABLE "signing_continuations"
  ADD COLUMN "oauth_scope" VARCHAR(512),
  ADD COLUMN "request_access" BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN "oauth_state" TYPE VARCHAR(2048);

-- Preserve the authorize-time public OAuth scope on the one-time code. The token endpoint
-- must never accept a broader client-submitted scope after authentication/signing.
ALTER TABLE "authorization_codes"
  ADD COLUMN "oauth_scope" VARCHAR(512);

ALTER TABLE "signing_continuations"
  ADD CONSTRAINT "signing_continuations_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "signing_continuations_expiry_check"
    CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "signing_continuations_profile_state_check"
    CHECK (
      (
        "auth_profile" = 'CONFIG_JWT'
        AND "config_url" IS NOT NULL
        AND "oauth_client_id" IS NULL
        AND "resource" IS NULL
        AND "oauth_state" IS NULL
        AND "oauth_scope" IS NULL
      )
      OR
      (
        "auth_profile" = 'PUBLIC_OAUTH'
        AND "config_url" IS NULL
        AND "oauth_client_id" IS NOT NULL
      )
    );
