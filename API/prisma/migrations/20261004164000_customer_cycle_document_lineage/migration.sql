BEGIN;

ALTER TABLE billing_customer_cycle_documents
  DROP CONSTRAINT billing_customer_cycle_documents_source_key;
ALTER TABLE billing_customer_cycle_documents
  DROP CONSTRAINT billing_customer_cycle_documents_kind_key;

CREATE UNIQUE INDEX billing_customer_cycle_documents_revision_source_key
  ON billing_customer_cycle_documents(cycle_id, source_kind, source_id, format);
CREATE INDEX billing_customer_cycle_documents_cycle_kind_idx
  ON billing_customer_cycle_documents(cycle_id, kind, format);

COMMIT;
