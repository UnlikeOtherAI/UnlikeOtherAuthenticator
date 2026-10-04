CREATE TABLE billing_stripe_cycle_corrections (
  id UUID PRIMARY KEY,
  close_id TEXT NOT NULL REFERENCES billing_stripe_invoice_closes(id) ON DELETE RESTRICT,
  authority_key CHAR(64) NOT NULL UNIQUE,
  ledger_snapshot_cursor VARCHAR(80) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL,
  tax_policy JSONB NOT NULL,
  source_digest CHAR(64) NOT NULL,
  stripe_invoice_id VARCHAR(255) UNIQUE,
  stripe_invoice_item_id VARCHAR(255) UNIQUE,
  paid_at TIMESTAMP(3), first_attempt_at TIMESTAMP(3),
  lease_token UUID, lease_expires_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX billing_stripe_cycle_corrections_close_paid_idx
  ON billing_stripe_cycle_corrections(close_id, paid_at);
CREATE UNIQUE INDEX billing_stripe_cycle_corrections_one_pending_idx
  ON billing_stripe_cycle_corrections(close_id) WHERE paid_at IS NULL;
CREATE FUNCTION protect_stripe_cycle_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'STRIPE_CYCLE_CORRECTION_IMMUTABLE'; END IF;
  IF ROW(NEW.id, NEW.close_id, NEW.authority_key, NEW.ledger_snapshot_cursor,
      NEW.amount_minor, NEW.currency, NEW.tax_policy, NEW.source_digest, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.close_id, OLD.authority_key, OLD.ledger_snapshot_cursor,
      OLD.amount_minor, OLD.currency, OLD.tax_policy, OLD.source_digest, OLD.created_at)
    OR (OLD.stripe_invoice_id IS NOT NULL AND NEW.stripe_invoice_id IS DISTINCT FROM OLD.stripe_invoice_id)
    OR (OLD.stripe_invoice_item_id IS NOT NULL AND NEW.stripe_invoice_item_id IS DISTINCT FROM OLD.stripe_invoice_item_id)
    OR (OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at)
    OR (OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at)
  THEN RAISE EXCEPTION 'STRIPE_CYCLE_CORRECTION_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stripe_cycle_correction_immutable BEFORE UPDATE OR DELETE
  ON billing_stripe_cycle_corrections FOR EACH ROW EXECUTE FUNCTION protect_stripe_cycle_correction();
