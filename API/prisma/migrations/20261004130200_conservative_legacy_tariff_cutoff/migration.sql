-- A changed default can leave no assignment timestamp. A later tariff version
-- establishes a lower bound; multiple versions without an administrator audit
-- cannot prove which version was the default in any historical month.
WITH observed AS (
  SELECT service."id", service."created_at", service."tariff_history_from_month",
    COUNT(DISTINCT tariff."id") AS tariff_count,
    MAX(tariff."created_at") AS latest_tariff_created,
    MAX(log."created_at") AS audited_change
  FROM "billing_services" service
  LEFT JOIN "billing_tariffs" tariff ON tariff."service_id" = service."id"
  LEFT JOIN "admin_audit_log" log
    ON log."action" IN ('billing.default_tariff_changed', 'billing.tariff_version_created')
    AND (log."metadata"->>'service_id' = service."id")
  GROUP BY service."id", service."created_at", service."tariff_history_from_month"
), cutoff AS (
  SELECT "id", GREATEST("tariff_history_from_month",
    CASE WHEN tariff_count > 1 AND audited_change IS NULL
      THEN to_char(date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 month',
        'YYYY-MM')
    WHEN latest_tariff_created > "created_at"
      AND to_char(latest_tariff_created, 'YYYY-MM') > to_char("created_at", 'YYYY-MM')
      THEN to_char(date_trunc('month', latest_tariff_created) + interval '1 month', 'YYYY-MM')
    ELSE "tariff_history_from_month" END) AS month
  FROM observed
)
UPDATE "billing_services" service SET "tariff_history_from_month" = cutoff.month
FROM cutoff WHERE service."id" = cutoff."id"
  AND service."tariff_history_from_month" < cutoff.month;
