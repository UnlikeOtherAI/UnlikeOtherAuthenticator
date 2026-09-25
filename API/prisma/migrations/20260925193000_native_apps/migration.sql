SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE TABLE "native_apps" (
  "id" TEXT PRIMARY KEY, "identifier" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true, "revision" INTEGER NOT NULL DEFAULT 1,
  "redirect_uris" TEXT[] NOT NULL, "scopes" TEXT[] NOT NULL, "methods" TEXT[] NOT NULL,
  "allow_registration" BOOLEAN NOT NULL DEFAULT false,
  "primary_color" TEXT NOT NULL, "background_color" TEXT NOT NULL, "text_color" TEXT NOT NULL,
  "icon_data" BYTEA, "icon_type" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "native_apps_revision_positive" CHECK (revision > 0)
);
GRANT SELECT, INSERT, UPDATE ON "native_apps" TO uoa_admin;
ALTER TABLE "native_apps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "native_apps" FORCE ROW LEVEL SECURITY;
CREATE TABLE "native_oauth_flows" (
  "id" TEXT PRIMARY KEY, "browser_hash" TEXT NOT NULL, "context" JSONB NOT NULL,
  "user_id" TEXT, "credential_epoch" INTEGER, "callback_used_at" TIMESTAMP(3),
  "used_at" TIMESTAMP(3), "expires_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "native_oauth_flows_expires_at_idx" ON "native_oauth_flows"("expires_at");
GRANT SELECT, INSERT, UPDATE, DELETE ON "native_oauth_flows" TO uoa_admin;
ALTER TABLE "native_oauth_flows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "native_oauth_flows" FORCE ROW LEVEL SECURITY;
ALTER TABLE "oauth_clients" ADD COLUMN "native_app_id" TEXT,
  ADD COLUMN "native_app_revision" INTEGER,
  ADD CONSTRAINT "oauth_clients_native_app_fkey" FOREIGN KEY ("native_app_id")
    REFERENCES "native_apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "oauth_clients_native_app_revision_pair" CHECK
    ((native_app_id IS NULL AND native_app_revision IS NULL) OR
     (native_app_id IS NOT NULL AND native_app_revision > 0)) NOT VALID;
