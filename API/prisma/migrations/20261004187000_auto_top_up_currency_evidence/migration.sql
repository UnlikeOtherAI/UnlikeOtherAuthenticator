-- Existing automatic top-ups could only be created from a USD policy/catalog.
-- Verify accepted historical financial evidence before freezing that fact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM billing_credit_auto_top_up_attempts attempt
    JOIN billing_stripe_webhook_events event ON event.id = attempt.success_webhook_event_id
    JOIN billing_credit_entries entry ON entry.id = attempt.credit_entry_id
    WHERE attempt.status = 'SUCCEEDED'
      AND (event.currency IS DISTINCT FROM 'USD' OR entry.currency IS DISTINCT FROM 'USD')
  ) THEN
    RAISE EXCEPTION 'historical automatic top-up currency evidence is not USD';
  END IF;
END;
$$;

ALTER TABLE billing_credit_auto_top_up_attempts
  ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE billing_credit_auto_top_up_attempts
  ADD CONSTRAINT billing_credit_auto_top_up_attempt_usd_only CHECK (currency = 'USD');
