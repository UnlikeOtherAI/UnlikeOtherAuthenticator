BEGIN;

-- Actual issuer voids supersede the current customer liability through a new
-- immutable cycle revision. Existing issued cycle rows and legal PDFs remain.
ALTER TABLE billing_customer_cycles
  DROP CONSTRAINT billing_customer_cycles_state_check;
ALTER TABLE billing_customer_cycles
  ADD CONSTRAINT billing_customer_cycles_state_check
  CHECK (state IN ('pending_reconciliation', 'finalized', 'adjusted', 'voided'));

COMMIT;
