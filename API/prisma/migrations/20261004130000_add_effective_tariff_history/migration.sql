-- Existing mutable pointers are trustworthy only from a month after their last
-- observed change. A service with no later mutation retains its initial month.
ALTER TABLE "billing_services"
  ADD COLUMN "tariff_history_from_month" CHAR(7) NOT NULL DEFAULT '9999-12';

CREATE TABLE "billing_tariff_term_events" (
  "id" TEXT NOT NULL,
  "sequence" BIGSERIAL NOT NULL,
  "service_id" TEXT NOT NULL,
  "source" "BillingTariffSource" NOT NULL,
  "scope_key" VARCHAR(520) NOT NULL,
  "effective_from_month" CHAR(7) NOT NULL,
  "tariff_id" TEXT,
  "assignment_id" TEXT,
  "reason" VARCHAR(60) NOT NULL,
  "actor_email" VARCHAR(200),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_tariff_term_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_tariff_term_events_month_check"
    CHECK ("effective_from_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "billing_tariff_term_events_source_check"
    CHECK (("source" = 'SERVICE_DEFAULT' AND "scope_key" = "service_id" AND "tariff_id" IS NOT NULL)
      OR ("source" IN ('ORGANISATION', 'TEAM')))
);
CREATE INDEX "billing_tariff_term_events_lookup_idx" ON "billing_tariff_term_events"
  ("service_id", "source", "scope_key", "effective_from_month", "created_at");
CREATE UNIQUE INDEX "billing_tariff_term_events_sequence_key"
  ON "billing_tariff_term_events"("sequence");
ALTER TABLE "billing_tariff_term_events" ADD CONSTRAINT "billing_tariff_term_events_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "billing_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_tariff_term_events" ADD CONSTRAINT "billing_tariff_term_events_tariff_id_fkey"
  FOREIGN KEY ("tariff_id") REFERENCES "billing_tariffs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_billing_tariff_term_event_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'billing tariff term events are append-only';
END $$;
CREATE TRIGGER billing_tariff_term_events_append_only
  BEFORE UPDATE OR DELETE ON "billing_tariff_term_events"
  FOR EACH ROW EXECUTE FUNCTION reject_billing_tariff_term_event_rewrite();
ALTER TABLE "billing_tariff_term_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_tariff_term_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_tariff_term_events_deny_app ON "billing_tariff_term_events"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);

WITH observed AS (
  SELECT service."id", service."created_at",
    (SELECT MAX(assignment."updated_at") FROM "billing_tariff_assignments" assignment
      WHERE assignment."service_id" = service."id") AS assignment_change,
    (SELECT MAX(log."created_at") FROM "admin_audit_log" log
      WHERE log."action" IN (
        'billing.default_tariff_changed', 'billing.tariff_version_created',
        'billing.assignment_upserted', 'billing.assignment_removed',
        'billing.contract_version_activated')
      AND (log."metadata"->>'service_id' = service."id"
        OR COALESCE(log."metadata"->'service_ids', '[]'::jsonb) ? service."id"
        OR COALESCE(log."metadata"->'removed_service_ids', '[]'::jsonb) ? service."id"))
      AS audited_change
  FROM "billing_services" service
), boundary AS (
  SELECT "id", CASE
    WHEN assignment_change IS NULL AND audited_change IS NULL
      THEN to_char("created_at", 'YYYY-MM')
    ELSE to_char(date_trunc('month', GREATEST(
      COALESCE(assignment_change, "created_at"),
      COALESCE(audited_change, "created_at")
    )) + interval '1 month', 'YYYY-MM')
  END AS month
  FROM observed
)
UPDATE "billing_services" service
SET "tariff_history_from_month" = boundary.month
FROM boundary WHERE service."id" = boundary."id";

INSERT INTO "billing_tariff_term_events"
  ("id", "service_id", "source", "scope_key", "effective_from_month",
   "tariff_id", "reason", "created_at")
SELECT 'backfill-default-' || tariff."id", tariff."service_id", 'SERVICE_DEFAULT',
  tariff."service_id", service."tariff_history_from_month", tariff."id",
  'verified-current-pointer', CURRENT_TIMESTAMP
FROM "billing_tariffs" tariff
JOIN "billing_services" service ON service."id" = tariff."service_id"
WHERE tariff."is_default" = true;

INSERT INTO "billing_tariff_term_events"
  ("id", "service_id", "source", "scope_key", "effective_from_month",
   "tariff_id", "assignment_id", "reason", "created_at")
SELECT 'backfill-assignment-' || assignment."id", assignment."service_id",
  assignment."scope"::text::"BillingTariffSource", assignment."scope_key",
  service."tariff_history_from_month", assignment."tariff_id", assignment."id",
  'verified-current-pointer', CURRENT_TIMESTAMP
FROM "billing_tariff_assignments" assignment
JOIN "billing_services" service ON service."id" = assignment."service_id";
