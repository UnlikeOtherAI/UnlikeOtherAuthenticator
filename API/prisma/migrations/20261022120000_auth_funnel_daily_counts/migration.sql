-- Daily per-client sign-up/sign-in funnel counts (Docs/Auth/signup-funnel-metrics.md).
-- Aggregates only: no email, IP, user id or token is ever stored here.
CREATE TABLE "auth_funnel_daily_counts" (
    "day" DATE NOT NULL,
    "domain" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "auth_funnel_daily_counts_pkey" PRIMARY KEY ("day","domain","step","outcome"),
    CONSTRAINT "auth_funnel_daily_counts_count_check" CHECK ("count" >= 0)
);

CREATE INDEX "auth_funnel_daily_counts_domain_day_idx" ON "auth_funnel_daily_counts"("domain", "day");

-- Admin-only: written by auth routes on the BYPASSRLS admin client, read by /internal/admin.
ALTER TABLE "auth_funnel_daily_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_funnel_daily_counts" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON "auth_funnel_daily_counts" FROM uoa_app;
    CREATE POLICY auth_funnel_daily_counts_deny_app ON "auth_funnel_daily_counts"
      FOR ALL TO uoa_app USING (false) WITH CHECK (false);
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_funnel_daily_counts" TO uoa_admin;
  END IF;
END $$;
