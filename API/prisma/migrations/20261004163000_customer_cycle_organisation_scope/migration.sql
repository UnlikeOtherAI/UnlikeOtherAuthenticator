BEGIN;

ALTER TABLE billing_customer_cycles
  ALTER COLUMN team_id DROP NOT NULL;

ALTER TABLE billing_customer_cycles
  ADD CONSTRAINT billing_customer_cycles_scope_check
    CHECK (team_id IS NOT NULL OR payer_scope = 'ORGANISATION');

ALTER TABLE billing_customer_cycles
  DROP CONSTRAINT billing_customer_cycles_binding;

CREATE UNIQUE INDEX billing_customer_cycles_team_revision_key
  ON billing_customer_cycles(service_id, team_id, billing_month, revision)
  WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX billing_customer_cycles_org_revision_key
  ON billing_customer_cycles(service_id, org_id, billing_month, revision)
  WHERE team_id IS NULL;

CREATE INDEX billing_customer_cycles_org_scope_idx
  ON billing_customer_cycles(service_id, org_id, billing_month)
  WHERE team_id IS NULL;

COMMIT;
