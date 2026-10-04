-- An accepted historical automatic payment must have both immutable success
-- event and credit entry, with matching USD currency. A missing row must not
-- silently inherit the new USD default as if its old currency were proven.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM billing_credit_auto_top_up_attempts attempt
    LEFT JOIN billing_stripe_webhook_events event
      ON event.id = attempt.success_webhook_event_id
    LEFT JOIN billing_credit_entries entry
      ON entry.id = attempt.credit_entry_id
    WHERE attempt.status = 'SUCCEEDED'
      AND (event.id IS NULL OR entry.id IS NULL
        OR event.currency IS DISTINCT FROM attempt.currency
        OR entry.currency IS DISTINCT FROM attempt.currency)
  ) THEN
    RAISE EXCEPTION 'historical automatic top-up currency lineage is incomplete';
  END IF;
END;
$$;
