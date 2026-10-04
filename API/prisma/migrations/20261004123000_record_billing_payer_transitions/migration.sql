BEGIN;
CREATE TABLE "billing_org_responsibility_transitions" (
  "id" TEXT NOT NULL,
  "responsibility_id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "kind" VARCHAR(8) NOT NULL,
  "effective_at" TIMESTAMP(3) NOT NULL,
  "actor_user_id" TEXT,
  "source" VARCHAR(24) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_org_responsibility_transitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_org_responsibility_transitions_kind_check" CHECK ("kind" IN ('ASSUMED', 'RELEASED')),
  CONSTRAINT "billing_org_responsibility_transitions_source_check" CHECK ("source" IN ('legacy_backfill', 'customer_action')),
  CONSTRAINT "billing_org_responsibility_transitions_responsibility_id_fkey"
    FOREIGN KEY ("responsibility_id") REFERENCES "billing_org_responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "billing_org_responsibility_transitions_responsibility_id_kind_effective_at_key"
  ON "billing_org_responsibility_transitions"("responsibility_id", "kind", "effective_at");
CREATE INDEX "billing_org_responsibility_transitions_org_id_effective_at_idx"
  ON "billing_org_responsibility_transitions"("org_id", "effective_at");

-- Only the latest interval can be reconstructed from the legacy mutable row.
-- If created_at predates assumed_at, older payer ownership remains uncertain
-- and the resolver holds it rather than inventing a prior TEAM interval.
INSERT INTO "billing_org_responsibility_transitions"
  ("id", "responsibility_id", "org_id", "kind", "effective_at", "actor_user_id", "source")
SELECT 'legacy_assumed_' || "id", "id", "org_id", 'ASSUMED', "assumed_at",
  "assumed_by_user_id", 'legacy_backfill'
FROM "billing_org_responsibilities";
INSERT INTO "billing_org_responsibility_transitions"
  ("id", "responsibility_id", "org_id", "kind", "effective_at", "actor_user_id", "source")
SELECT 'legacy_released_' || "id", "id", "org_id", 'RELEASED', "released_at",
  "released_by_user_id", 'legacy_backfill'
FROM "billing_org_responsibilities" WHERE "released_at" IS NOT NULL;

CREATE FUNCTION "billing_org_responsibility_transition_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'billing payer transition history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "billing_org_responsibility_transition_immutable"
BEFORE UPDATE OR DELETE ON "billing_org_responsibility_transitions"
FOR EACH ROW EXECUTE FUNCTION "billing_org_responsibility_transition_immutable"();
COMMIT;
