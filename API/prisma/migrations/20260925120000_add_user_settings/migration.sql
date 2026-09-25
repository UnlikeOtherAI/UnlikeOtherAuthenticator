-- User settings (Docs/Auth/user-settings.md). Purely additive: no existing table changes, no data
-- migration. Each row is one key inside one namespace of one user's settings, holding arbitrary
-- JSON. The name-format and size checks mirror the API validation so a bypassing writer still
-- cannot store an unaddressable key or blow the per-value cap.
--
-- RLS follows the per-user child-table classification used by `user_avatars` (20260725120000):
-- settings reads and writes happen on dual-auth (domain hash + access token) paths that run
-- outside a tenant context, so they use the BYPASSRLS admin client and `uoa_app` is denied
-- outright. Guarded with pg_roles checks so local/dev databases without the RLS roles keep
-- working unchanged.

CREATE TABLE "user_settings" (
  "user_id" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id", "namespace", "key"),
  CONSTRAINT "user_settings_namespace_check" CHECK ("namespace" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  CONSTRAINT "user_settings_key_check" CHECK ("key" ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  CONSTRAINT "user_settings_size_bytes_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 262144),
  CONSTRAINT "user_settings_value_not_null_check" CHECK (jsonb_typeof("value") <> 'null')
);

ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "user_settings" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user_settings" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_settings_deny_app ON "user_settings"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
