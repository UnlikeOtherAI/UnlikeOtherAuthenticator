BEGIN;
CREATE TABLE billing_credit_budget_legacy_liabilities (
  dispatch_id varchar(160) PRIMARY KEY,
  receipt_id varchar(160) NOT NULL UNIQUE,
  service_id text NOT NULL,
  org_id text NOT NULL,
  team_id text NOT NULL,
  user_id text NOT NULL,
  billing_month char(7) NOT NULL,
  rated_microcredits bigint NOT NULL CHECK (rated_microcredits >= 0),
  source_type varchar(40) NOT NULL,
  source_id varchar(160) NOT NULL,
  occurred_at timestamp(3) NOT NULL,
  imported_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_type, source_id),
  CONSTRAINT billing_credit_budget_legacy_source CHECK
    (source_type IN ('prepaid_wallet_debit','historical_payg_settlement'))
);
CREATE INDEX billing_credit_budget_legacy_scope_month_idx
  ON billing_credit_budget_legacy_liabilities (service_id, org_id, team_id, billing_month);

CREATE FUNCTION billing_credit_budget_legacy_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'legacy credit budget liability is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER billing_credit_budget_legacy_immutable
BEFORE UPDATE OR DELETE ON billing_credit_budget_legacy_liabilities
FOR EACH ROW EXECUTE FUNCTION billing_credit_budget_legacy_immutable();
COMMIT;
