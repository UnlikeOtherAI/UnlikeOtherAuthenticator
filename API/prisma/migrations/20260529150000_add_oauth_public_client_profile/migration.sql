-- Public-client / MCP OAuth profile (brief §22.14).

-- 1. authorization_codes: config_url becomes nullable (the public profile has no
--    client-supplied config URL); add oauth_client_id / resource / state for it.
ALTER TABLE "authorization_codes" ALTER COLUMN "config_url" DROP NOT NULL;
ALTER TABLE "authorization_codes" ADD COLUMN "oauth_client_id" TEXT;
ALTER TABLE "authorization_codes" ADD COLUMN "resource" TEXT;
ALTER TABLE "authorization_codes" ADD COLUMN "state" TEXT;

-- 2. oauth_clients: PUBLIC clients only — there is deliberately NO secret column
--    (brief §22.3). The only stored state is the redirect-URI allow-list.
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_name" TEXT,
    "redirect_uris" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- 3. Grants + RLS. The registry is read/written only through the BYPASSRLS admin
--    path (DCR registration and the pre-tenant-context authorize/token lookups).
--    Enable + force RLS with no policy so the runtime uoa_app role is denied;
--    uoa_admin (BYPASSRLS) is unaffected. Mirrors the per-table pattern in
--    20260423093000_add_apps_startup_tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "oauth_clients" TO uoa_admin;
ALTER TABLE "oauth_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_clients" FORCE ROW LEVEL SECURITY;
