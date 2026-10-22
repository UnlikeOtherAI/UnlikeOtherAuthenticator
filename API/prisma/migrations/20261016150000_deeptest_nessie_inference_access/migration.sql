-- Operator-only permission. Existing and future accounts are denied until explicitly enabled.
ALTER TABLE "users" ADD COLUMN "deeptest_nessie_inference_allowed" BOOLEAN NOT NULL DEFAULT false;
