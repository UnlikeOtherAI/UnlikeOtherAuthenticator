CREATE TYPE "AutomaticMembershipOperationStatus" AS ENUM ('accepted', 'completed', 'already_member', 'failed', 'cancelled');
CREATE TABLE "automatic_membership_provision_fences" (
  "id" text PRIMARY KEY,
  "service_id" text NOT NULL REFERENCES "billing_services"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "rule_id" text NOT NULL,
  "generation" integer NOT NULL,
  "fence_token" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("service_id", "rule_id")
);
CREATE TABLE "automatic_membership_operations" (
  "id" text PRIMARY KEY,
  "service_id" text NOT NULL REFERENCES "billing_services"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "rule_id" text NOT NULL,
  "generation" integer NOT NULL,
  "fence_token" text NOT NULL,
  "subject_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "status" "AutomaticMembershipOperationStatus" NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("service_id", "idempotency_key")
);
