BEGIN;

-- Admission decisions are immutable. Cancellation evidence is a separate
-- receipt, just as a settlement is an immutable paid-usage liability.
CREATE TABLE billing_ledger_dispatch_releases (
  dispatch_id varchar(160) PRIMARY KEY
    REFERENCES billing_ledger_dispatch_decisions(dispatch_id) ON DELETE RESTRICT,
  receipt_id varchar(160) NOT NULL UNIQUE,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION billing_ledger_dispatch_release_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ledger dispatch releases are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER billing_ledger_dispatch_release_immutable
BEFORE UPDATE OR DELETE ON billing_ledger_dispatch_releases
FOR EACH ROW EXECUTE FUNCTION billing_ledger_dispatch_release_immutable();

ALTER TABLE billing_ledger_dispatch_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_ledger_dispatch_releases FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_ledger_dispatch_releases FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT ON billing_ledger_dispatch_releases TO uoa_admin;

COMMIT;
