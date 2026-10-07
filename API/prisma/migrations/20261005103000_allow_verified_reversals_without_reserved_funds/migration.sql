BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A verified refund/dispute can create debt after purchased credits were spent.
-- This guard protects active funds only; the existing entry provenance and
-- usage-debit guards still validate every balance change independently.
CREATE OR REPLACE FUNCTION billing_prepaid_protect_reserved_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held BIGINT;
BEGIN
  SELECT COALESCE(SUM("reserved_microcredits"), 0) INTO held
    FROM "billing_prepaid_reservations"
    WHERE "credit_account_id" = NEW."id" AND "status" = 'ACTIVE';
  IF held > 0 AND NEW."balance_microcredits" < held THEN
    RAISE EXCEPTION 'prepaid reserved balance cannot be consumed';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
