-- App-scoped startup payload support: Apps, kill switches, feature flags, and overrides.

CREATE TABLE "apps" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "identifier" VARCHAR(160) NOT NULL,
  "platform" VARCHAR(20) NOT NULL,
  "domains" JSONB NOT NULL DEFAULT '[]',
  "store_url" TEXT,
  "offline_policy" VARCHAR(20) NOT NULL DEFAULT 'allow',
  "poll_interval_seconds" INTEGER NOT NULL DEFAULT 300,
  "feature_flags_enabled" BOOLEAN NOT NULL DEFAULT false,
  "role_flag_matrix_enabled" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "apps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "apps_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "kill_switch_entries" (
  "id" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "platform" VARCHAR(20) NOT NULL,
  "type" VARCHAR(20) NOT NULL,
  "version_field" VARCHAR(20) NOT NULL,
  "operator" VARCHAR(10) NOT NULL DEFAULT 'eq',
  "version_value" VARCHAR(80) NOT NULL,
  "version_max" VARCHAR(80),
  "version_scheme" VARCHAR(20) NOT NULL,
  "name" VARCHAR(120),
  "store_url" TEXT,
  "title_key" VARCHAR(160),
  "title" TEXT,
  "message_key" VARCHAR(160),
  "message" TEXT,
  "primary_button_key" VARCHAR(160),
  "primary_button" TEXT,
  "secondary_button_key" VARCHAR(160),
  "secondary_button" TEXT,
  "latest_version" VARCHAR(80),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "activate_at" TIMESTAMP(3),
  "deactivate_at" TIMESTAMP(3),
  "priority" INTEGER NOT NULL DEFAULT 0,
  "test_user_ids" JSONB NOT NULL DEFAULT '[]',
  "cache_ttl" INTEGER NOT NULL DEFAULT 3600,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "kill_switch_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "kill_switch_entries_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "feature_flag_definitions" (
  "id" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "key" VARCHAR(80) NOT NULL,
  "description" VARCHAR(500),
  "default_state" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "feature_flag_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feature_flag_definitions_app_id_key_key" UNIQUE ("app_id", "key"),
  CONSTRAINT "feature_flag_definitions_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "feature_flag_role_values" (
  "id" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "flag_key" VARCHAR(80) NOT NULL,
  "role_name" VARCHAR(100) NOT NULL,
  "value" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "feature_flag_role_values_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feature_flag_role_values_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feature_flag_role_values_app_id_flag_key_fkey" FOREIGN KEY ("app_id", "flag_key") REFERENCES "feature_flag_definitions"("app_id", "key") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "feature_flag_user_overrides" (
  "id" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "flag_key" VARCHAR(80) NOT NULL,
  "user_id" TEXT NOT NULL,
  "value" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "feature_flag_user_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feature_flag_user_overrides_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feature_flag_user_overrides_app_id_flag_key_fkey" FOREIGN KEY ("app_id", "flag_key") REFERENCES "feature_flag_definitions"("app_id", "key") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feature_flag_user_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "apps_org_id_identifier_key" ON "apps"("org_id", "identifier");
CREATE INDEX "apps_identifier_idx" ON "apps"("identifier");
CREATE INDEX "apps_org_id_idx" ON "apps"("org_id");

CREATE INDEX "kill_switch_entries_app_id_idx" ON "kill_switch_entries"("app_id");
CREATE INDEX "kill_switch_entries_app_id_active_priority_idx" ON "kill_switch_entries"("app_id", "active", "priority");
CREATE INDEX "kill_switch_entries_activate_at_idx" ON "kill_switch_entries"("activate_at");

CREATE INDEX "feature_flag_definitions_app_id_idx" ON "feature_flag_definitions"("app_id");

CREATE UNIQUE INDEX "feature_flag_role_values_app_id_role_name_flag_key_key" ON "feature_flag_role_values"("app_id", "role_name", "flag_key");
CREATE INDEX "feature_flag_role_values_app_id_flag_key_idx" ON "feature_flag_role_values"("app_id", "flag_key");

CREATE UNIQUE INDEX "feature_flag_user_overrides_app_id_user_id_flag_key_key" ON "feature_flag_user_overrides"("app_id", "user_id", "flag_key");
CREATE INDEX "feature_flag_user_overrides_user_id_idx" ON "feature_flag_user_overrides"("user_id");
CREATE INDEX "feature_flag_user_overrides_app_id_flag_key_idx" ON "feature_flag_user_overrides"("app_id", "flag_key");

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "apps",
  "kill_switch_entries",
  "feature_flag_definitions",
  "feature_flag_role_values",
  "feature_flag_user_overrides"
TO uoa_app, uoa_admin;

ALTER TABLE "apps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "apps" FORCE ROW LEVEL SECURITY;
CREATE POLICY apps_select ON "apps"
  FOR SELECT TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));
CREATE POLICY apps_insert ON "apps"
  FOR INSERT TO uoa_app
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));
CREATE POLICY apps_update ON "apps"
  FOR UPDATE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''))
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''));
CREATE POLICY apps_delete ON "apps"
  FOR DELETE TO uoa_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), ''));

ALTER TABLE "kill_switch_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kill_switch_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY kill_switch_entries_select ON "kill_switch_entries"
  FOR SELECT TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = kill_switch_entries.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
CREATE POLICY kill_switch_entries_insert ON "kill_switch_entries"
  FOR INSERT TO uoa_app
  WITH CHECK (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = kill_switch_entries.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
CREATE POLICY kill_switch_entries_update ON "kill_switch_entries"
  FOR UPDATE TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = kill_switch_entries.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = kill_switch_entries.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
CREATE POLICY kill_switch_entries_delete ON "kill_switch_entries"
  FOR DELETE TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = kill_switch_entries.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));

ALTER TABLE "feature_flag_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY feature_flag_definitions_select ON "feature_flag_definitions"
  FOR SELECT TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_definitions.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
CREATE POLICY feature_flag_definitions_insert ON "feature_flag_definitions"
  FOR INSERT TO uoa_app
  WITH CHECK (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_definitions.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
CREATE POLICY feature_flag_definitions_update ON "feature_flag_definitions"
  FOR UPDATE TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_definitions.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_definitions.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
CREATE POLICY feature_flag_definitions_delete ON "feature_flag_definitions"
  FOR DELETE TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_definitions.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));

ALTER TABLE "feature_flag_role_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_role_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY feature_flag_role_values_select ON "feature_flag_role_values"
  FOR SELECT TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_role_values.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
CREATE POLICY feature_flag_role_values_write ON "feature_flag_role_values"
  FOR ALL TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_role_values.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_role_values.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));

ALTER TABLE "feature_flag_user_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_user_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY feature_flag_user_overrides_select ON "feature_flag_user_overrides"
  FOR SELECT TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_user_overrides.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
CREATE POLICY feature_flag_user_overrides_write ON "feature_flag_user_overrides"
  FOR ALL TO uoa_app
  USING (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_user_overrides.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM "apps" a WHERE a.id = feature_flag_user_overrides.app_id AND a.org_id = NULLIF(current_setting('app.org_id', true), '')));
