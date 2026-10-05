BEGIN;

-- A signed Ledger receipt may name a historical billing team after its live
-- identity/membership row was deleted. Financial lineage stores that stable
-- string and org binding without recreating identity or granting access.
ALTER TABLE billing_customer_cycles
  DROP CONSTRAINT billing_customer_cycles_team_id_fkey;
COMMENT ON COLUMN billing_customer_cycles.team_id IS
  'Historical Ledger billing team identifier; not a live teams FK or authorization grant';

COMMIT;
