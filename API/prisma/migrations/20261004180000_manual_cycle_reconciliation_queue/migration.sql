BEGIN;

-- Invoice effects are queued in the same transaction that records their
-- authority. A generation prevents a worker from deleting a newer event.
CREATE TABLE billing_manual_cycle_reconciliation_queue (
  invoice_id text PRIMARY KEY REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  generation bigint NOT NULL DEFAULT 1,
  priority smallint NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error_code varchar(100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_manual_cycle_queue_generation_positive CHECK (generation > 0),
  CONSTRAINT billing_manual_cycle_queue_attempts_nonnegative CHECK (attempts >= 0)
);

CREATE INDEX billing_manual_cycle_queue_due_idx
  ON billing_manual_cycle_reconciliation_queue(priority, due_at, invoice_id);

-- Resolve the trigger table's owning schema explicitly. This also lets the
-- migration run in isolated test schemas without trusting a caller search_path.
CREATE FUNCTION billing_enqueue_manual_cycle_source(
  target_schema name, target_invoice_id text
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE allocated boolean;
BEGIN
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I.billing_customer_cycle_invoice_allocations
      WHERE source_kind = ''manual'' AND source_invoice_id = $1)', target_schema
  ) INTO allocated USING target_invoice_id;
  IF allocated THEN
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

CREATE FUNCTION billing_enqueue_manual_cycle_invoice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE target_invoice_id text;
BEGIN
  IF TG_TABLE_NAME = 'billing_customer_cycle_invoice_allocations' THEN
    IF NEW.source_kind <> 'manual' THEN RETURN NEW; END IF;
    target_invoice_id := NEW.source_invoice_id;
  ELSE
    target_invoice_id := NEW.invoice_id;
  END IF;
  EXECUTE format('SELECT %I.billing_enqueue_manual_cycle_source($1, $2)', TG_TABLE_SCHEMA)
    USING TG_TABLE_SCHEMA, target_invoice_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_manual_cycle_allocation_enqueue
AFTER INSERT ON billing_customer_cycle_invoice_allocations
FOR EACH ROW EXECUTE FUNCTION billing_enqueue_manual_cycle_invoice();

CREATE TRIGGER billing_manual_cycle_payment_enqueue
AFTER INSERT ON billing_invoice_payment_events
FOR EACH ROW EXECUTE FUNCTION billing_enqueue_manual_cycle_invoice();

CREATE FUNCTION billing_enqueue_manual_cycle_invoice_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR
     NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    EXECUTE format('SELECT %I.billing_enqueue_manual_cycle_source($1, $2)', TG_TABLE_SCHEMA)
      USING TG_TABLE_SCHEMA, NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_manual_cycle_invoice_enqueue
AFTER UPDATE OF status, voided_at ON billing_invoices
FOR EACH ROW EXECUTE FUNCTION billing_enqueue_manual_cycle_invoice_transition();

-- One-time durable backfill of effects allocated before this migration. New
-- events have priority zero, so a large history cannot delay fresh changes.
INSERT INTO billing_manual_cycle_reconciliation_queue (invoice_id, priority)
SELECT DISTINCT source_invoice_id, 1
FROM billing_customer_cycle_invoice_allocations
WHERE source_kind = 'manual'
ON CONFLICT (invoice_id) DO NOTHING;

COMMIT;
