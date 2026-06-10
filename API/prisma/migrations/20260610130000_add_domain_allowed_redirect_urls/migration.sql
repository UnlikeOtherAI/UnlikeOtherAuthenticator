-- Admin-managed allowed redirect URLs at the client-domain level. Empty array = no admin
-- additions (the client's signed config `redirect_urls` remains the allowlist). When non-empty,
-- these URLs are unioned into the effective allowed redirect set so a superuser can centrally
-- permit additional redirect targets without the partner re-signing their config JWT.
ALTER TABLE "client_domains" ADD COLUMN "allowed_redirect_urls" TEXT[] NOT NULL DEFAULT '{}';
