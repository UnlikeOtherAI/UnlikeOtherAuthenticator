BEGIN;

-- Issuance is the source event. Allocation may fail after the legal PDF is
-- frozen, so the durable queue must include issued invoices with no customer
-- cycle allocation yet. Existing allocated payment/void events still use the
-- same generation-based wake-up path.
CREATE OR REPLACE FUNCTION billing_enqueue_manual_cycle_source(
  target_schema name, target_invoice_id text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE eligible boolean;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I.billing_invoices
       WHERE id = $1 AND status = ''ISSUED'') OR EXISTS (
       SELECT 1 FROM %I.billing_customer_cycle_invoice_allocations
       WHERE source_kind = ''manual'' AND source_invoice_id = $1)',
    target_schema, target_schema
  ) INTO eligible USING target_invoice_id;
  IF eligible THEN
    EXECUTE format(
      'INSERT INTO %I.billing_manual_cycle_reconciliation_queue AS queue (invoice_id)
       VALUES ($1) ON CONFLICT (invoice_id) DO UPDATE SET
       generation = queue.generation + 1, priority = 0, due_at = now(),
       lease_token = NULL, lease_expires_at = NULL, attempts = 0,
       last_error_code = NULL, updated_at = now()', target_schema
    ) USING target_invoice_id;
  END IF;
END;
$$;

INSERT INTO billing_manual_cycle_reconciliation_queue (invoice_id, priority)
SELECT invoice.id, 1 FROM billing_invoices AS invoice
WHERE invoice.status = 'ISSUED'
  AND NOT EXISTS (SELECT 1 FROM billing_manual_cycle_reconciliation_queue AS queue
    WHERE queue.invoice_id = invoice.id)
ON CONFLICT (invoice_id) DO NOTHING;

COMMIT;
