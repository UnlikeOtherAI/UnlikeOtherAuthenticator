ALTER TABLE "domain_signature_settings"
  DROP CONSTRAINT IF EXISTS "domain_signature_settings_retention_days_check";

ALTER TABLE "domain_signature_settings"
  ADD CONSTRAINT "domain_signature_settings_retention_days_check"
    CHECK ("retention_days" IS NULL OR "retention_days" BETWEEN 1 AND 36500);
