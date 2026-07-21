ALTER TABLE "billing_credit_entries"
  DROP CONSTRAINT "billing_credit_entries_kind_check",
  ADD CONSTRAINT "billing_credit_entries_kind_check" CHECK (
    ("kind" IN ('TOP_UP', 'AUTOMATIC_TOP_UP') AND "direction" = 'CREDIT' AND "attributed_user_id" IS NOT NULL)
    OR ("kind" = 'USAGE_SETTLEMENT' AND "direction" = 'DEBIT')
    OR ("kind" = 'USAGE_SETTLEMENT_CORRECTION')
    OR (
      "kind" IN ('REFUND', 'DISPUTE')
      AND "direction" = 'DEBIT'
      AND "reverses_entry_id" IS NOT NULL
      AND "source_type" = 'credit_payment_adjustment'
    )
    OR (
      "kind" IN ('REFUND_REVERSAL', 'DISPUTE_REVERSAL')
      AND "direction" = 'CREDIT'
      AND "reverses_entry_id" IS NOT NULL
      AND "source_type" = 'credit_payment_adjustment'
    )
    OR ("kind" = 'ADJUSTMENT')
  );

ALTER TABLE "billing_credit_payment_adjustments"
  ALTER COLUMN "credit_entry_id" DROP NOT NULL,
  DROP CONSTRAINT "billing_credit_payment_adjustments_values_check",
  ADD CONSTRAINT "billing_credit_payment_adjustments_values_check" CHECK (
    "currency" = 'USD'
    AND "amount_minor" > 0
    AND "amount_microcredits" >= 0
    AND "amount_microcredits"::numeric <= "amount_minor"::numeric * 10000000
    AND "amount_microcredits" % 10000000 = 0
    AND (
      ("amount_microcredits" = 0 AND "credit_entry_id" IS NULL)
      OR ("amount_microcredits" > 0 AND "credit_entry_id" IS NOT NULL)
    )
    AND length(btrim("idempotency_key")) > 0
    AND "stripe_payment_intent_id" ~ '^pi_[A-Za-z0-9_-]+$'
    AND "stripe_charge_id" ~ '^ch_[A-Za-z0-9_-]+$'
    AND (
      ("kind" IN ('REFUND', 'REFUND_REVERSAL') AND "stripe_object_id" ~ '^re_[A-Za-z0-9_-]+$')
      OR ("kind" IN ('DISPUTE', 'DISPUTE_REVERSAL') AND "stripe_object_id" ~ '^dp_[A-Za-z0-9_-]+$')
    )
  );
