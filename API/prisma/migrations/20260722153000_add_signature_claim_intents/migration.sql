-- Durable signing claims split database policy decisions from object/PDF/crypto work.
-- Billing's 20260722140000 intent migration is intentionally ordered before this one.

CREATE TYPE "SignatureClaimIntentStatus" AS ENUM (
  'CLAIMED',
  'EVIDENCE_READY',
  'COMPLETED',
  'INVALIDATED'
);

CREATE TABLE "signature_claim_intents" (
  "id" TEXT NOT NULL,
  "status" "SignatureClaimIntentStatus" NOT NULL DEFAULT 'CLAIMED',
  "signing_continuation_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "user_email" CITEXT NOT NULL,
  "signer_name" VARCHAR(200) NOT NULL,
  "domain" TEXT NOT NULL,
  "agreement_id" TEXT NOT NULL,
  "agreement_version_id" TEXT NOT NULL,
  "agreement_version" INTEGER NOT NULL,
  "agreement_title" VARCHAR(200) NOT NULL,
  "source_storage_key" TEXT NOT NULL,
  "source_pdf_sha256" VARCHAR(64) NOT NULL,
  "signing_method" "SignatureMethod" NOT NULL,
  "typed_name" VARCHAR(200),
  "acceptance_statement" TEXT NOT NULL,
  "signed_at" TIMESTAMP(3) NOT NULL,
  "auth_method" VARCHAR(32) NOT NULL,
  "two_fa_completed" BOOLEAN NOT NULL,
  "ip_address" VARCHAR(64),
  "user_agent" VARCHAR(1000),
  "policy_revision" INTEGER NOT NULL,
  "prior_signature_state_sha256" VARCHAR(64) NOT NULL,
  "continuation_expires_at" TIMESTAMP(3) NOT NULL,
  "verification_reference" VARCHAR(64) NOT NULL,
  "evidence_manifest_sha256" VARCHAR(64),
  "receipt_pdf_sha256" VARCHAR(64),
  "receipt_storage_key" TEXT,
  "evidence_key_id" VARCHAR(200),
  "evidence_signature" TEXT,
  "evidence_ready_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "invalidated_at" TIMESTAMP(3),
  "invalidation_reason" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "signature_claim_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signature_claim_intents_version_check" CHECK ("agreement_version" > 0),
  CONSTRAINT "signature_claim_intents_policy_revision_check" CHECK ("policy_revision" >= 0),
  CONSTRAINT "signature_claim_intents_source_hash_check"
    CHECK ("source_pdf_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "signature_claim_intents_prior_state_hash_check"
    CHECK ("prior_signature_state_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "signature_claim_intents_typed_name_check" CHECK (
    ("signing_method" = 'TYPED_NAME' AND "typed_name" IS NOT NULL AND length(btrim("typed_name")) > 0)
    OR ("signing_method" = 'CLICKWRAP' AND "typed_name" IS NULL)
  ),
  CONSTRAINT "signature_claim_intents_state_check" CHECK (
    (
      "status" = 'CLAIMED'
      AND "evidence_manifest_sha256" IS NULL
      AND "receipt_pdf_sha256" IS NULL
      AND "receipt_storage_key" IS NULL
      AND "evidence_key_id" IS NULL
      AND "evidence_signature" IS NULL
      AND "evidence_ready_at" IS NULL
      AND "completed_at" IS NULL
      AND "invalidated_at" IS NULL
      AND "invalidation_reason" IS NULL
    )
    OR (
      "status" = 'EVIDENCE_READY'
      AND "evidence_manifest_sha256" IS NOT NULL
      AND "evidence_manifest_sha256" ~ '^[0-9a-f]{64}$'
      AND "receipt_pdf_sha256" IS NOT NULL
      AND "receipt_pdf_sha256" ~ '^[0-9a-f]{64}$'
      AND "receipt_storage_key" IS NOT NULL
      AND "evidence_key_id" IS NOT NULL
      AND "evidence_signature" IS NOT NULL
      AND "evidence_ready_at" IS NOT NULL
      AND "completed_at" IS NULL
      AND "invalidated_at" IS NULL
      AND "invalidation_reason" IS NULL
    )
    OR (
      "status" = 'COMPLETED'
      AND "evidence_manifest_sha256" IS NOT NULL
      AND "evidence_manifest_sha256" ~ '^[0-9a-f]{64}$'
      AND "receipt_pdf_sha256" IS NOT NULL
      AND "receipt_pdf_sha256" ~ '^[0-9a-f]{64}$'
      AND "receipt_storage_key" IS NOT NULL
      AND "evidence_key_id" IS NOT NULL
      AND "evidence_signature" IS NOT NULL
      AND "evidence_ready_at" IS NOT NULL
      AND "completed_at" IS NOT NULL
      AND "invalidated_at" IS NULL
      AND "invalidation_reason" IS NULL
    )
    OR (
      "status" = 'INVALIDATED'
      AND "completed_at" IS NULL
      AND "invalidated_at" IS NOT NULL
      AND "invalidation_reason" IS NOT NULL
      AND (
        (
          "evidence_manifest_sha256" IS NULL
          AND "receipt_pdf_sha256" IS NULL
          AND "receipt_storage_key" IS NULL
          AND "evidence_key_id" IS NULL
          AND "evidence_signature" IS NULL
          AND "evidence_ready_at" IS NULL
        )
        OR (
          "evidence_manifest_sha256" IS NOT NULL
          AND "evidence_manifest_sha256" ~ '^[0-9a-f]{64}$'
          AND "receipt_pdf_sha256" IS NOT NULL
          AND "receipt_pdf_sha256" ~ '^[0-9a-f]{64}$'
          AND "receipt_storage_key" IS NOT NULL
          AND "evidence_key_id" IS NOT NULL
          AND "evidence_signature" IS NOT NULL
          AND "evidence_ready_at" IS NOT NULL
        )
      )
    )
  )
);

CREATE UNIQUE INDEX "signature_claim_intents_verification_reference_key"
  ON "signature_claim_intents"("verification_reference");
CREATE UNIQUE INDEX "signature_claim_intents_receipt_storage_key_key"
  ON "signature_claim_intents"("receipt_storage_key");
CREATE UNIQUE INDEX "signature_claim_intents_continuation_version_key"
  ON "signature_claim_intents"("signing_continuation_id", "agreement_version_id");
CREATE INDEX "signature_claim_intents_domain_status_created_at_idx"
  ON "signature_claim_intents"("domain", "status", "created_at");
CREATE INDEX "signature_claim_intents_user_id_domain_agreement_version_id_idx"
  ON "signature_claim_intents"("user_id", "domain", "agreement_version_id");

ALTER TABLE "signature_claim_intents" ADD CONSTRAINT "signature_claim_intents_continuation_fkey"
  FOREIGN KEY ("signing_continuation_id") REFERENCES "signing_continuations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signature_claim_intents" ADD CONSTRAINT "signature_claim_intents_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signature_claim_intents" ADD CONSTRAINT "signature_claim_intents_domain_fkey"
  FOREIGN KEY ("domain") REFERENCES "client_domains"("domain") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signature_claim_intents" ADD CONSTRAINT "signature_claim_intents_version_fkey"
  FOREIGN KEY ("agreement_version_id") REFERENCES "agreement_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agreement_signatures" ADD COLUMN "claim_intent_id" TEXT;
CREATE UNIQUE INDEX "agreement_signatures_claim_intent_id_key"
  ON "agreement_signatures"("claim_intent_id");
ALTER TABLE "agreement_signatures" ADD CONSTRAINT "agreement_signatures_claim_intent_id_fkey"
  FOREIGN KEY ("claim_intent_id") REFERENCES "signature_claim_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION uoa_enforce_signature_claim_intent_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signature claim intents are append-only'
      USING ERRCODE = '55000';
  END IF;

  IF (to_jsonb(NEW) - ARRAY[
        'status',
        'evidence_manifest_sha256',
        'receipt_pdf_sha256',
        'receipt_storage_key',
        'evidence_key_id',
        'evidence_signature',
        'evidence_ready_at',
        'completed_at',
        'invalidated_at',
        'invalidation_reason',
        'updated_at'
      ])
     <> (to_jsonb(OLD) - ARRAY[
        'status',
        'evidence_manifest_sha256',
        'receipt_pdf_sha256',
        'receipt_storage_key',
        'evidence_key_id',
        'evidence_signature',
        'evidence_ready_at',
        'completed_at',
        'invalidated_at',
        'invalidation_reason',
        'updated_at'
      ]) THEN
    RAISE EXCEPTION 'signature claim inputs are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" IN ('COMPLETED', 'INVALIDATED') THEN
    RAISE EXCEPTION 'terminal signature claim intents are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'CLAIMED' AND NEW."status" NOT IN ('EVIDENCE_READY', 'INVALIDATED') THEN
    RAISE EXCEPTION 'invalid signature claim intent transition'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'EVIDENCE_READY' AND NEW."status" NOT IN ('COMPLETED', 'INVALIDATED') THEN
    RAISE EXCEPTION 'invalid signature claim intent transition'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'EVIDENCE_READY' AND (
    NEW."evidence_manifest_sha256" IS DISTINCT FROM OLD."evidence_manifest_sha256"
    OR NEW."receipt_pdf_sha256" IS DISTINCT FROM OLD."receipt_pdf_sha256"
    OR NEW."receipt_storage_key" IS DISTINCT FROM OLD."receipt_storage_key"
    OR NEW."evidence_key_id" IS DISTINCT FROM OLD."evidence_key_id"
    OR NEW."evidence_signature" IS DISTINCT FROM OLD."evidence_signature"
    OR NEW."evidence_ready_at" IS DISTINCT FROM OLD."evidence_ready_at"
  ) THEN
    RAISE EXCEPTION 'signature claim evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER signature_claim_intents_state_machine
  BEFORE UPDATE OR DELETE ON "signature_claim_intents"
  FOR EACH ROW EXECUTE FUNCTION uoa_enforce_signature_claim_intent_state();

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "signature_claim_intents" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "signature_claim_intents" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "signature_claim_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signature_claim_intents" FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_claim_intents_deny_app ON "signature_claim_intents"
  FOR ALL TO uoa_app USING (false) WITH CHECK (false);
