-- Preserve the source team's liability even when one organisation account pays it.
-- Existing adjustments are immutable: ambiguous legacy rows remain unassigned
-- and require manual reconciliation before further settlement on their payer/month.
BEGIN;
ALTER TABLE "billing_credit_usage_settlements" ADD COLUMN "team_id" TEXT;
-- Ambiguous legacy rows remain immutable and are held for reconciliation;
-- one such row must never block schema deployment for unrelated accounts.
-- The existing identity trigger rejects changes to newly added identity columns.
-- Hold an exclusive table lock and suspend only that trigger for this
-- lineage-only backfill; transaction rollback restores it on any failure.
ALTER TABLE "billing_credit_usage_settlements"
  DISABLE TRIGGER "billing_credit_usage_settlements_immutable_identity";
UPDATE "billing_credit_usage_settlements" s SET "team_id" = COALESCE(a."team_id", (
  SELECT min(p."team_id")
  FROM "billing_credit_usage_settlement_adjustments" x
  JOIN "billing_credit_portfolio_snapshots" p ON p."id" = x."portfolio_snapshot_id"
  WHERE x."settlement_id" = s."id"
)) FROM "billing_credit_accounts" a
WHERE a."id" = s."credit_account_id"
  AND NOT EXISTS (
    SELECT 1 FROM "billing_credit_usage_settlement_adjustments" x
    JOIN "billing_credit_portfolio_snapshots" p ON p."id" = x."portfolio_snapshot_id"
    WHERE x."settlement_id" = s."id"
    GROUP BY x."settlement_id"
    HAVING count(DISTINCT p."team_id") > 1
       OR (a."team_id" IS NOT NULL AND min(p."team_id") IS DISTINCT FROM a."team_id")
  );
ALTER TABLE "billing_credit_usage_settlements"
  ENABLE TRIGGER "billing_credit_usage_settlements_immutable_identity";
ALTER TABLE "billing_credit_usage_settlements"
  ADD CONSTRAINT "billing_credit_usage_settlements_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "billing_credit_usage_settlements_credit_account_id_service__key";
CREATE UNIQUE INDEX "billing_credit_settlement_team_service_month_key"
  ON "billing_credit_usage_settlements"("credit_account_id", "team_id", "service_id", "billing_month");
DROP INDEX "billing_credit_portfolio_snapshot_ledger_id_key";
DROP INDEX "billing_credit_portfolio_snapshot_cursor_key";
CREATE UNIQUE INDEX "billing_credit_portfolio_snapshot_team_ledger_id_key"
  ON "billing_credit_portfolio_snapshots"("credit_account_id", "team_id", "ledger_snapshot_id");
CREATE UNIQUE INDEX "billing_credit_portfolio_snapshot_team_cursor_key"
  ON "billing_credit_portfolio_snapshots"("credit_account_id", "team_id", "ledger_snapshot_cursor");

CREATE OR REPLACE FUNCTION "billing_credit_portfolio_snapshot_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_row "billing_credit_accounts"%ROWTYPE;
  latest_cursor TEXT;
  latest_captured_at TIMESTAMP(3);
  perspective_identifier TEXT;
BEGIN
  SELECT * INTO account_row
  FROM "billing_credit_accounts"
  WHERE "id" = NEW."credit_account_id"
  FOR UPDATE;
  SELECT "identifier" INTO perspective_identifier
  FROM "billing_services"
  WHERE "id" = NEW."perspective_service_id";
  IF NOT FOUND
     OR account_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR account_row."org_id" IS DISTINCT FROM NEW."org_id"
     OR (
       account_row."scope" = 'TEAM'
       AND account_row."team_id" IS DISTINCT FROM NEW."team_id"
     )
     OR (
       account_row."scope" = 'ORGANISATION'
       AND NOT EXISTS (
         SELECT 1 FROM "teams" AS snapshot_team
         WHERE snapshot_team."id" = NEW."team_id"
           AND snapshot_team."org_id" = account_row."org_id"
       )
     )
     OR perspective_identifier IS DISTINCT FROM NEW."perspective_product" THEN
    RAISE EXCEPTION 'Ledger portfolio snapshot does not match the paying credit account'
      USING ERRCODE = '23514';
  END IF;
  SELECT snapshot."ledger_snapshot_cursor", snapshot."captured_at"
    INTO latest_cursor, latest_captured_at
  FROM "billing_credit_portfolio_snapshots" AS snapshot
  WHERE snapshot."credit_account_id" = NEW."credit_account_id"
    AND snapshot."billing_month" = NEW."billing_month"
    AND snapshot."team_id" = NEW."team_id"
  ORDER BY snapshot."captured_at" DESC, snapshot."ledger_snapshot_cursor" DESC
  LIMIT 1;
  IF latest_cursor IS NOT NULL
     AND NEW."ledger_snapshot_cursor" IS DISTINCT FROM latest_cursor
     AND NEW."captured_at" <= latest_captured_at THEN
    RAISE EXCEPTION 'stale Ledger portfolio snapshot cannot correct newer team usage'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_settlement_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  credit_row "billing_credit_accounts"%ROWTYPE;
  tariff_row "billing_tariffs"%ROWTYPE;
  subscription_row "billing_stripe_subscriptions"%ROWTYPE;
BEGIN
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = NEW."credit_account_id";
  SELECT * INTO tariff_row FROM "billing_tariffs"
    WHERE "id" = NEW."tariff_id";
  PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", false);
  IF TG_OP = 'INSERT' THEN
    PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
  END IF;
  IF (TG_OP = 'INSERT' AND NEW."team_id" IS NULL)
     OR credit_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR credit_row."currency" IS DISTINCT FROM 'USD'
     OR (NEW."team_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "teams" t WHERE t."id" = NEW."team_id" AND t."org_id" = credit_row."org_id"))
     OR (credit_row."team_id" IS NOT NULL AND credit_row."team_id" IS DISTINCT FROM NEW."team_id")
     OR tariff_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR tariff_row."currency" IS DISTINCT FROM 'USD'
     OR NEW."currency" <> 'USD' THEN
    RAISE EXCEPTION 'credit settlement must use the shared account and exact USD tariff service'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."subscription_id" IS NOT NULL THEN
    SELECT * INTO subscription_row FROM "billing_stripe_subscriptions"
      WHERE "id" = NEW."subscription_id";
    IF subscription_row."account_id" IS DISTINCT FROM NEW."account_id"
       OR subscription_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR subscription_row."tariff_id" IS DISTINCT FROM NEW."tariff_id"
       OR subscription_row."org_id" IS DISTINCT FROM credit_row."org_id"
       OR (
         subscription_row."team_id" IS NOT NULL
         AND subscription_row."team_id" IS DISTINCT FROM NEW."team_id"
       ) THEN
      RAISE EXCEPTION 'credit settlement subscription does not cover the exact team service'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'PENDING'
    OR NEW."cumulative_rated_usage_amount_micro_minor" <> 0
    OR NEW."cumulative_credits_consumed_microcredits" <> 0
    OR NEW."cumulative_remaining_usage_amount_micro_minor" <> 0
  ) THEN
    RAISE EXCEPTION 'new settlement must begin pending at exact zero cumulative totals'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW."cumulative_rated_usage_amount_micro_minor"
         IS DISTINCT FROM OLD."cumulative_rated_usage_amount_micro_minor"
       OR NEW."cumulative_credits_consumed_microcredits"
         IS DISTINCT FROM OLD."cumulative_credits_consumed_microcredits"
       OR NEW."cumulative_remaining_usage_amount_micro_minor"
         IS DISTINCT FROM OLD."cumulative_remaining_usage_amount_micro_minor"
     )
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'settlement totals may advance only through an immutable adjustment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_settlement_adjustment_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_row "billing_credit_usage_settlements"%ROWTYPE;
  snapshot_row "billing_credit_portfolio_snapshots"%ROWTYPE;
  entry_row "billing_credit_entries"%ROWTYPE;
  expected_kind "BillingCreditEntryKind";
  expected_direction "BillingCreditEntryDirection";
  next_sequence INTEGER;
  previous_snapshot_id TEXT;
  previous_snapshot_captured_at TIMESTAMP(3);
BEGIN
  SELECT * INTO settlement_row
  FROM "billing_credit_usage_settlements"
  WHERE "id" = NEW."settlement_id"
  FOR UPDATE;
  IF NOT FOUND
     OR settlement_row."account_id" <> NEW."account_id"
     OR settlement_row."credit_account_id" <> NEW."credit_account_id"
     OR settlement_row."service_id" <> NEW."service_id" THEN
    RAISE EXCEPTION 'settlement adjustment does not match its aggregate settlement'
      USING ERRCODE = '23514';
  END IF;
  PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
  SELECT * INTO snapshot_row
  FROM "billing_credit_portfolio_snapshots"
  WHERE "id" = NEW."portfolio_snapshot_id";
  IF NOT FOUND
     OR snapshot_row."account_id" IS DISTINCT FROM NEW."account_id"
     OR snapshot_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
     OR snapshot_row."billing_month" IS DISTINCT FROM settlement_row."billing_month"
     OR snapshot_row."team_id" IS DISTINCT FROM settlement_row."team_id"
     OR snapshot_row."contract" IS DISTINCT FROM 'metering-portfolio-v1'
     OR snapshot_row."group_by" IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'settlement adjustment must use the exact team-wide user portfolio snapshot'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max(adjustment."sequence"), 0) + 1 INTO next_sequence
  FROM "billing_credit_usage_settlement_adjustments" AS adjustment
  WHERE adjustment."settlement_id" = NEW."settlement_id";
  IF NEW."sequence" <> next_sequence THEN
    RAISE EXCEPTION 'settlement adjustment sequence does not continue the locked chain'
      USING ERRCODE = '40001';
  END IF;
  SELECT previous_snapshot."id", previous_snapshot."captured_at"
    INTO previous_snapshot_id, previous_snapshot_captured_at
  FROM "billing_credit_usage_settlement_adjustments" AS adjustment
  JOIN "billing_credit_portfolio_snapshots" AS previous_snapshot
    ON previous_snapshot."id" = adjustment."portfolio_snapshot_id"
  WHERE adjustment."settlement_id" = NEW."settlement_id"
  ORDER BY adjustment."sequence" DESC
  LIMIT 1;
  IF previous_snapshot_id IS NOT NULL
     AND snapshot_row."id" IS DISTINCT FROM previous_snapshot_id
     AND snapshot_row."captured_at" <= previous_snapshot_captured_at THEN
    RAISE EXCEPTION 'settlement adjustment cannot apply an older portfolio snapshot'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."cumulative_rated_usage_amount_micro_minor"
       <> settlement_row."cumulative_rated_usage_amount_micro_minor"
          + NEW."delta_rated_usage_amount_micro_minor"
     OR NEW."cumulative_credits_consumed_microcredits"
       <> settlement_row."cumulative_credits_consumed_microcredits"
          + NEW."delta_credits_consumed_microcredits"
     OR NEW."cumulative_remaining_usage_amount_micro_minor"
       <> settlement_row."cumulative_remaining_usage_amount_micro_minor"
          + NEW."delta_remaining_usage_amount_micro_minor" THEN
    RAISE EXCEPTION 'settlement adjustment does not continue the locked cumulative chain'
      USING ERRCODE = '40001';
  END IF;

  IF NEW."delta_credits_consumed_microcredits" <> 0 THEN
    SELECT * INTO entry_row FROM "billing_credit_entries"
      WHERE "id" = NEW."credit_entry_id";
    expected_kind := CASE
      WHEN settlement_row."cumulative_rated_usage_amount_micro_minor" = 0
       AND settlement_row."cumulative_credits_consumed_microcredits" = 0
       AND settlement_row."cumulative_remaining_usage_amount_micro_minor" = 0
        THEN 'USAGE_SETTLEMENT'::"BillingCreditEntryKind"
      ELSE 'USAGE_SETTLEMENT_CORRECTION'::"BillingCreditEntryKind"
    END;
    expected_direction := CASE
      WHEN NEW."delta_credits_consumed_microcredits" > 0
        THEN 'DEBIT'::"BillingCreditEntryDirection"
      ELSE 'CREDIT'::"BillingCreditEntryDirection"
    END;
    IF entry_row."credit_account_id" IS DISTINCT FROM NEW."credit_account_id"
       OR entry_row."service_id" IS DISTINCT FROM NEW."service_id"
       OR entry_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
       OR entry_row."attributed_user_id" IS NOT NULL
       OR entry_row."kind" IS DISTINCT FROM expected_kind
       OR entry_row."direction" IS DISTINCT FROM expected_direction
       OR entry_row."amount_microcredits"::numeric
          IS DISTINCT FROM abs(NEW."delta_credits_consumed_microcredits"::numeric)
       OR entry_row."source_type" IS DISTINCT FROM 'credit_usage_settlement_adjustment'
       OR entry_row."source_id" IS DISTINCT FROM NEW."id" THEN
      RAISE EXCEPTION 'settlement adjustment does not match its aggregate credit entry'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE "billing_credit_usage_settlements"
  SET "cumulative_rated_usage_amount_micro_minor" = NEW."cumulative_rated_usage_amount_micro_minor",
      "cumulative_credits_consumed_microcredits" = NEW."cumulative_credits_consumed_microcredits",
      "cumulative_remaining_usage_amount_micro_minor" = NEW."cumulative_remaining_usage_amount_micro_minor",
      "status" = 'APPLIED',
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."settlement_id";
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_credit_usage_allocation_coherence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  adjustment_row "billing_credit_usage_settlement_adjustments"%ROWTYPE;
  settlement_row "billing_credit_usage_settlements"%ROWTYPE;
  credit_row "billing_credit_accounts"%ROWTYPE;
  previous_row "billing_credit_usage_allocations"%ROWTYPE;
BEGIN
  SELECT * INTO adjustment_row
  FROM "billing_credit_usage_settlement_adjustments"
  WHERE "id" = NEW."adjustment_id";
  SELECT * INTO settlement_row
  FROM "billing_credit_usage_settlements"
  WHERE "id" = NEW."settlement_id"
  FOR KEY SHARE;
  SELECT * INTO credit_row FROM "billing_credit_accounts"
    WHERE "id" = settlement_row."credit_account_id";
  IF adjustment_row."settlement_id" IS DISTINCT FROM NEW."settlement_id"
     OR adjustment_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR adjustment_row."app_key_id" IS DISTINCT FROM NEW."app_key_id"
     OR settlement_row."service_id" IS DISTINCT FROM NEW."service_id" THEN
    RAISE EXCEPTION 'usage allocation does not match its aggregate adjustment'
      USING ERRCODE = '23514';
  END IF;
  PERFORM "billing_assert_credit_app_key_provenance"(NEW."app_key_id", true);
  IF NEW."attributed_user_id" IS NOT NULL THEN
    PERFORM "billing_assert_credit_scope_user"(
      credit_row."org_id", settlement_row."team_id", NEW."attributed_user_id", false
    );
  END IF;

  SELECT allocation.* INTO previous_row
  FROM "billing_credit_usage_allocations" AS allocation
  JOIN "billing_credit_usage_settlement_adjustments" AS adjustment
    ON adjustment."id" = allocation."adjustment_id"
  WHERE allocation."settlement_id" = NEW."settlement_id"
    AND allocation."adjustment_id" <> NEW."adjustment_id"
    AND allocation."attributed_user_id" IS NOT DISTINCT FROM NEW."attributed_user_id"
    AND adjustment."sequence" < adjustment_row."sequence"
  ORDER BY adjustment."sequence" DESC
  LIMIT 1;

  IF NEW."cumulative_rated_usage_amount_micro_minor"
       <> COALESCE(previous_row."cumulative_rated_usage_amount_micro_minor", 0)
          + NEW."delta_rated_usage_amount_micro_minor"
     OR NEW."cumulative_credits_consumed_microcredits"
       <> COALESCE(previous_row."cumulative_credits_consumed_microcredits", 0)
          + NEW."delta_credits_consumed_microcredits"
     OR NEW."cumulative_remaining_usage_amount_micro_minor"
       <> COALESCE(previous_row."cumulative_remaining_usage_amount_micro_minor", 0)
          + NEW."delta_remaining_usage_amount_micro_minor" THEN
    RAISE EXCEPTION 'usage allocation does not continue its per-user cumulative chain'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
