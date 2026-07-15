-- Database-level invariants for immutable agreement and signature evidence.

ALTER TABLE "domain_signature_settings"
  ADD CONSTRAINT "domain_signature_settings_policy_revision_check"
    CHECK ("policy_revision" >= 0),
  ADD CONSTRAINT "domain_signature_settings_retention_days_check"
    CHECK ("retention_days" IS NULL OR "retention_days" > 0);

ALTER TABLE "agreement_versions"
  ADD CONSTRAINT "agreement_versions_version_check"
    CHECK ("version" > 0),
  ADD CONSTRAINT "agreement_versions_source_hash_check"
    CHECK ("source_pdf_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "agreement_versions_publication_state_check"
    CHECK (
      ("status" = 'DRAFT' AND "published_at" IS NULL AND "published_by_email" IS NULL)
      OR
      ("status" <> 'DRAFT' AND "published_at" IS NOT NULL AND "published_by_email" IS NOT NULL)
    );

ALTER TABLE "agreement_signatures"
  ADD CONSTRAINT "agreement_signatures_source_hash_check"
    CHECK ("source_pdf_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "agreement_signatures_manifest_hash_check"
    CHECK ("evidence_manifest_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "agreement_signatures_receipt_hash_check"
    CHECK ("receipt_pdf_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "agreement_signatures_typed_name_check"
    CHECK (
      ("signing_method" = 'TYPED_NAME' AND "typed_name" IS NOT NULL AND length(btrim("typed_name")) > 0)
      OR
      ("signing_method" = 'CLICKWRAP' AND "typed_name" IS NULL)
    );

CREATE UNIQUE INDEX "agreement_versions_one_published_per_agreement"
  ON "agreement_versions"("agreement_id")
  WHERE "status" = 'PUBLISHED';

CREATE UNIQUE INDEX "agreement_versions_source_storage_key_key"
  ON "agreement_versions"("source_storage_key");

CREATE UNIQUE INDEX "agreement_signatures_receipt_storage_key_key"
  ON "agreement_signatures"("receipt_storage_key");

CREATE UNIQUE INDEX "agreement_signatures_continuation_version_key"
  ON "agreement_signatures"("signing_continuation_id", "agreement_version_id");

CREATE OR REPLACE FUNCTION uoa_enforce_agreement_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'published agreement versions are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT', 'PUBLISHED') THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PUBLISHED'
     AND NEW."status" IN ('SUPERSEDED', 'WITHDRAWN')
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'published agreement versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER agreement_versions_immutable
  BEFORE UPDATE OR DELETE ON "agreement_versions"
  FOR EACH ROW EXECUTE FUNCTION uoa_enforce_agreement_version_immutability();

CREATE OR REPLACE FUNCTION uoa_reject_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'signature evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER agreement_signatures_append_only
  BEFORE UPDATE OR DELETE ON "agreement_signatures"
  FOR EACH ROW EXECUTE FUNCTION uoa_reject_evidence_mutation();

CREATE TRIGGER signature_revocations_append_only
  BEFORE UPDATE OR DELETE ON "signature_revocations"
  FOR EACH ROW EXECUTE FUNCTION uoa_reject_evidence_mutation();

CREATE TRIGGER signature_audit_events_append_only
  BEFORE UPDATE OR DELETE ON "signature_audit_events"
  FOR EACH ROW EXECUTE FUNCTION uoa_reject_evidence_mutation();
