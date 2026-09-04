CREATE TABLE "automatic_membership_subject_snapshots" (
  "id" text PRIMARY KEY,
  "service_id" text NOT NULL REFERENCES "billing_services"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "domain_ascii" text NOT NULL,
  "cutoff_at" timestamp(3) NOT NULL,
  "expires_at" timestamp(3) NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "automatic_membership_subject_snapshots_expiry_idx" ON "automatic_membership_subject_snapshots" ("expires_at");
