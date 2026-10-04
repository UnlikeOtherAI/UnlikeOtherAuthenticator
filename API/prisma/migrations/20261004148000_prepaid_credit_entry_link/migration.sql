ALTER TABLE "billing_credit_entries"
  ADD COLUMN "prepaid_reservation_id" TEXT UNIQUE REFERENCES "billing_prepaid_reservations"("id") ON DELETE RESTRICT;
ALTER TABLE "billing_credit_entries"
  ADD CONSTRAINT "billing_credit_entry_prepaid_link_check" CHECK (
    ("kind" = 'PREPAID_USAGE' AND "prepaid_reservation_id" IS NOT NULL
      AND "source_id" = "prepaid_reservation_id")
    OR ("kind" <> 'PREPAID_USAGE' AND "prepaid_reservation_id" IS NULL)
  );
