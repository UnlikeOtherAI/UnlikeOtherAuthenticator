SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Every grant of credits is a lot: the currency it was bought in, what was paid,
-- the USD per unit the credits were granted at, and what is left. Debits draw
-- lots oldest-first, one movement row per lot, inside the debit's own insert, so
-- a balance can always be valued in what was actually paid for it. Movements
-- without a lot are debt that only a verified payment reversal can create.
CREATE TABLE billing_credit_lots (
  id TEXT NOT NULL,
  credit_account_id TEXT NOT NULL,
  source_entry_id TEXT,
  sequence INTEGER NOT NULL,
  currency CHAR(3) NOT NULL,
  paid_amount_minor BIGINT NOT NULL,
  usd_per_unit DECIMAL(38,18) NOT NULL,
  granted_microcredits BIGINT NOT NULL,
  remaining_microcredits BIGINT NOT NULL,
  opened_at TIMESTAMP(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_credit_lots_pkey PRIMARY KEY (id),
  CONSTRAINT billing_credit_lots_credit_account_id_fkey FOREIGN KEY (credit_account_id)
    REFERENCES billing_credit_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT billing_credit_lots_source_entry_id_fkey FOREIGN KEY (source_entry_id)
    REFERENCES billing_credit_entries(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Only a balance that predates lots and was not explained by a grant has no source entry.
  CONSTRAINT billing_credit_lot_shape CHECK (
    currency IN ('USD', 'EUR', 'GBP') AND paid_amount_minor >= 0 AND usd_per_unit > 0
    AND (currency <> 'USD' OR usd_per_unit = 1)
    AND granted_microcredits > 0 AND remaining_microcredits >= 0
    AND remaining_microcredits <= granted_microcredits
    AND (source_entry_id IS NOT NULL OR (currency = 'USD' AND sequence = 0)))
);
CREATE UNIQUE INDEX billing_credit_lots_source_entry_id_key ON billing_credit_lots(source_entry_id);
CREATE UNIQUE INDEX billing_credit_lots_credit_account_id_sequence_key
  ON billing_credit_lots(credit_account_id, sequence);
CREATE INDEX billing_credit_lots_open_idx ON billing_credit_lots(credit_account_id, sequence)
  WHERE remaining_microcredits > 0;

CREATE TABLE billing_credit_lot_movements (
  id BIGSERIAL NOT NULL,
  credit_account_id TEXT NOT NULL,
  lot_id TEXT,
  entry_id TEXT,
  delta_microcredits BIGINT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_credit_lot_movements_pkey PRIMARY KEY (id),
  CONSTRAINT billing_credit_lot_movements_credit_account_id_fkey FOREIGN KEY (credit_account_id)
    REFERENCES billing_credit_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT billing_credit_lot_movements_lot_id_fkey FOREIGN KEY (lot_id)
    REFERENCES billing_credit_lots(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT billing_credit_lot_movements_entry_id_fkey FOREIGN KEY (entry_id)
    REFERENCES billing_credit_entries(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- A movement without an entry is only the debt of a balance that predates lots.
  CONSTRAINT billing_credit_lot_movement_shape CHECK (
    delta_microcredits <> 0 AND (entry_id IS NOT NULL OR (lot_id IS NULL AND delta_microcredits < 0)))
);
CREATE INDEX billing_credit_lot_movements_entry_id_idx ON billing_credit_lot_movements(entry_id);
CREATE INDEX billing_credit_lot_movements_lot_id_idx ON billing_credit_lot_movements(lot_id);
CREATE INDEX billing_credit_lot_movements_debt_idx ON billing_credit_lot_movements(credit_account_id)
  WHERE lot_id IS NULL;

-- Lots change only in what is left, and only through entries; movements never change.
CREATE FUNCTION billing_credit_lot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW.id, NEW.credit_account_id, NEW.source_entry_id, NEW.sequence, NEW.currency,
      NEW.paid_amount_minor, NEW.usd_per_unit, NEW.granted_microcredits, NEW.opened_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.credit_account_id, OLD.source_entry_id, OLD.sequence, OLD.currency,
      OLD.paid_amount_minor, OLD.usd_per_unit, OLD.granted_microcredits, OLD.opened_at) THEN
    RAISE EXCEPTION 'a credit lot keeps its terms; only what is left changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_credit_lot_guard BEFORE UPDATE OR DELETE ON billing_credit_lots
  FOR EACH ROW EXECUTE FUNCTION billing_credit_lot_guard();
CREATE FUNCTION billing_credit_lot_movement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'credit lot movements are immutable' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER billing_credit_lot_movement_immutable BEFORE UPDATE OR DELETE ON billing_credit_lot_movements
  FOR EACH ROW EXECUTE FUNCTION billing_credit_lot_movement_immutable();

CREATE FUNCTION billing_credit_lot_debt(account TEXT) RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(-SUM(delta_microcredits), 0)::bigint FROM billing_credit_lot_movements
  WHERE credit_account_id = account AND lot_id IS NULL
$$;

-- Move `amount` between one lot and an entry: negative draws, positive gives back.
CREATE FUNCTION billing_credit_lot_move(lot TEXT, account TEXT, entry TEXT, delta BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF delta = 0 THEN RETURN; END IF;
  IF lot IS NOT NULL THEN
    UPDATE billing_credit_lots SET remaining_microcredits = remaining_microcredits + delta,
      updated_at = CURRENT_TIMESTAMP WHERE id = lot;
  END IF;
  INSERT INTO billing_credit_lot_movements (credit_account_id, lot_id, entry_id, delta_microcredits)
  VALUES (account, lot, entry, delta);
END $$;

-- A balance from before lots: each historical grant becomes a rate-1 USD lot
-- (every earlier purchase was USD), consumed oldest-first by what was spent;
-- credits no grant explains open one USD lot; a negative balance is debt. The
-- migration backfills every account; an account's first entry backfills it too
-- when it has no lot history, which only a balance written outside entries has.
-- `pending` is an entry already applied to the balance but not yet to lots: the
-- backfill describes the balance before it.
CREATE FUNCTION billing_credit_lots_backfill(account TEXT, pending billing_credit_entries DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  account_balance BIGINT;
  granted NUMERIC;
  consumed NUMERIC;
  take NUMERIC;
  seq INTEGER := 0;
  grant_row RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM billing_credit_lots WHERE credit_account_id = account)
     OR EXISTS (SELECT 1 FROM billing_credit_lot_movements WHERE credit_account_id = account) THEN
    RETURN;
  END IF;
  SELECT balance_microcredits INTO account_balance FROM billing_credit_accounts WHERE id = account FOR UPDATE;
  IF pending.id IS NOT NULL THEN
    account_balance := account_balance - CASE pending.direction
      WHEN 'CREDIT' THEN pending.amount_microcredits ELSE -pending.amount_microcredits END;
  END IF;
  SELECT COALESCE(SUM(amount_microcredits), 0) INTO granted FROM billing_credit_entries
    WHERE credit_account_id = account AND direction = 'CREDIT'
      AND kind IN ('TOP_UP', 'AUTOMATIC_TOP_UP', 'ADJUSTMENT') AND id IS DISTINCT FROM pending.id;
  consumed := GREATEST(granted - GREATEST(account_balance, 0), 0);
  IF account_balance > granted THEN
    INSERT INTO billing_credit_lots (id, credit_account_id, source_entry_id, sequence, currency,
      paid_amount_minor, usd_per_unit, granted_microcredits, remaining_microcredits, opened_at)
    VALUES ('bcl_open_' || account, account, NULL, 0, 'USD', ((account_balance - granted) / 10000000)::bigint,
      1, (account_balance - granted)::bigint, (account_balance - granted)::bigint, CURRENT_TIMESTAMP);
  END IF;
  FOR grant_row IN
    SELECT entry.id, entry.amount_microcredits, entry.occurred_at,
      COALESCE(checkout.payment_amount_minor, attempt.payment_amount_minor, 0) AS paid
    FROM billing_credit_entries AS entry
    LEFT JOIN billing_credit_top_up_checkouts AS checkout
      ON entry.kind = 'TOP_UP' AND checkout.id = entry.source_id
    LEFT JOIN billing_credit_auto_top_up_attempts AS attempt
      ON entry.kind = 'AUTOMATIC_TOP_UP' AND attempt.id = entry.source_id
    WHERE entry.credit_account_id = account AND entry.direction = 'CREDIT'
      AND entry.kind IN ('TOP_UP', 'AUTOMATIC_TOP_UP', 'ADJUSTMENT') AND entry.id IS DISTINCT FROM pending.id
    ORDER BY entry.occurred_at, entry.created_at, entry.id
  LOOP
    seq := seq + 1;
    take := LEAST(consumed, grant_row.amount_microcredits);
    consumed := consumed - take;
    INSERT INTO billing_credit_lots (id, credit_account_id, source_entry_id, sequence, currency,
      paid_amount_minor, usd_per_unit, granted_microcredits, remaining_microcredits, opened_at)
    VALUES ('bcl_' || grant_row.id, account, grant_row.id, seq, 'USD', grant_row.paid, 1,
      grant_row.amount_microcredits, (grant_row.amount_microcredits - take)::bigint, grant_row.occurred_at);
  END LOOP;
  IF account_balance < 0 THEN
    INSERT INTO billing_credit_lot_movements (credit_account_id, lot_id, entry_id, delta_microcredits)
    VALUES (account, NULL, NULL, account_balance);
  END IF;
END $$;

-- Apply one entry to its account's lots. The entry trigger has already locked the
-- account row, so every lot change for an account is serialized.
CREATE FUNCTION billing_credit_lots_apply_entry(entry billing_credit_entries) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  account TEXT := entry.credit_account_id;
  left_over BIGINT := entry.amount_microcredits;
  take BIGINT;
  debt BIGINT;
  lot billing_credit_lots%ROWTYPE;
  lot_currency CHAR(3);
  lot_paid BIGINT;
  lot_rate NUMERIC;
  new_lot TEXT;
  lots_total NUMERIC;
  account_balance BIGINT;
BEGIN
  PERFORM billing_credit_lots_backfill(account, entry);
  IF entry.direction = 'CREDIT' AND entry.kind IN ('TOP_UP', 'AUTOMATIC_TOP_UP', 'ADJUSTMENT') THEN
    IF entry.kind = 'TOP_UP' THEN
      SELECT checkout.currency, checkout.payment_amount_minor, COALESCE(checkout.fx_base_rate, 1)
        INTO lot_currency, lot_paid, lot_rate
        FROM billing_credit_top_up_checkouts AS checkout WHERE checkout.id = entry.source_id;
    ELSIF entry.kind = 'AUTOMATIC_TOP_UP' THEN
      SELECT attempt.currency, attempt.payment_amount_minor, 1 INTO lot_currency, lot_paid, lot_rate
        FROM billing_credit_auto_top_up_attempts AS attempt WHERE attempt.id = entry.source_id;
    ELSE
      lot_currency := 'USD'; lot_paid := 0; lot_rate := 1;
    END IF;
    IF lot_currency IS NULL THEN
      RAISE EXCEPTION 'a credit grant needs its purchase evidence to open a lot' USING ERRCODE = '23514';
    END IF;
    new_lot := 'bcl_' || entry.id;
    INSERT INTO billing_credit_lots (id, credit_account_id, source_entry_id, sequence, currency,
      paid_amount_minor, usd_per_unit, granted_microcredits, remaining_microcredits, opened_at)
    SELECT new_lot, account, entry.id, COALESCE(MAX(existing.sequence), 0) + 1, lot_currency, lot_paid,
      lot_rate, entry.amount_microcredits, entry.amount_microcredits, entry.occurred_at
    FROM billing_credit_lots AS existing WHERE existing.credit_account_id = account;
    -- A grant first pays down debt a verified payment reversal left behind.
    debt := billing_credit_lot_debt(account);
    IF debt > 0 THEN
      take := LEAST(debt, entry.amount_microcredits);
      PERFORM billing_credit_lot_move(new_lot, account, entry.id, -take);
      PERFORM billing_credit_lot_move(NULL, account, entry.id, take);
    END IF;
  ELSIF entry.direction = 'CREDIT' THEN
    -- A usage correction or payment reversal gives credits back: first to any debt,
    -- then to the reversed payment's own lot, then to the newest lot that gave any.
    debt := billing_credit_lot_debt(account);
    IF debt > 0 THEN
      take := LEAST(debt, left_over);
      PERFORM billing_credit_lot_move(NULL, account, entry.id, take);
      left_over := left_over - take;
    END IF;
    IF left_over > 0 AND entry.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO lot FROM billing_credit_lots WHERE source_entry_id = entry.reverses_entry_id FOR UPDATE;
      IF lot.id IS NOT NULL THEN
        take := LEAST(lot.granted_microcredits - lot.remaining_microcredits, left_over);
        PERFORM billing_credit_lot_move(lot.id, account, entry.id, take);
        left_over := left_over - take;
      END IF;
    END IF;
    FOR lot IN SELECT * FROM billing_credit_lots
        WHERE credit_account_id = account AND remaining_microcredits < granted_microcredits
        ORDER BY sequence DESC FOR UPDATE LOOP
      EXIT WHEN left_over = 0;
      take := LEAST(lot.granted_microcredits - lot.remaining_microcredits, left_over);
      PERFORM billing_credit_lot_move(lot.id, account, entry.id, take);
      left_over := left_over - take;
    END LOOP;
    IF left_over > 0 THEN
      RAISE EXCEPTION 'credits given back exceed what the lots have given' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- A refund or dispute draws its own payment's lot first; every debit then draws oldest-first.
    IF entry.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO lot FROM billing_credit_lots WHERE source_entry_id = entry.reverses_entry_id FOR UPDATE;
      IF lot.id IS NOT NULL THEN
        take := LEAST(lot.remaining_microcredits, left_over);
        PERFORM billing_credit_lot_move(lot.id, account, entry.id, -take);
        left_over := left_over - take;
      END IF;
    END IF;
    FOR lot IN SELECT * FROM billing_credit_lots
        WHERE credit_account_id = account AND remaining_microcredits > 0
        ORDER BY sequence ASC FOR UPDATE LOOP
      EXIT WHEN left_over = 0;
      take := LEAST(lot.remaining_microcredits, left_over);
      PERFORM billing_credit_lot_move(lot.id, account, entry.id, -take);
      left_over := left_over - take;
    END LOOP;
    -- Only a verified reversal can leave more debited than the lots hold.
    PERFORM billing_credit_lot_move(NULL, account, entry.id, -left_over);
  END IF;

  SELECT COALESCE(SUM(remaining_microcredits), 0) INTO lots_total
    FROM billing_credit_lots WHERE credit_account_id = account;
  SELECT balance_microcredits INTO account_balance FROM billing_credit_accounts WHERE id = account;
  IF lots_total - billing_credit_lot_debt(account) <> account_balance THEN
    RAISE EXCEPTION 'credit lots do not match the account balance' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION billing_credit_entry_lots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_credit_lots_apply_entry(NEW);
  RETURN NULL;
END $$;
CREATE TRIGGER billing_credit_entries_apply_lots AFTER INSERT ON billing_credit_entries
  FOR EACH ROW EXECUTE FUNCTION billing_credit_entry_lots();

SELECT billing_credit_lots_backfill(id) FROM billing_credit_accounts;

-- A region values credits bought in USD at one rate, captured once when it is
-- chosen (USD per unit of the region currency, 1 for US); that is the only
-- change a region row accepts.
ALTER TABLE billing_organisation_regions
  ADD COLUMN usd_per_unit DECIMAL(38,18),
  ADD CONSTRAINT billing_organisation_region_rate CHECK (
    usd_per_unit IS NULL OR (usd_per_unit > 0 AND (currency <> 'USD' OR usd_per_unit = 1)));
CREATE OR REPLACE FUNCTION billing_organisation_region_set_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.usd_per_unit IS NULL AND NEW.usd_per_unit IS NOT NULL
     AND ROW(NEW.org_id, NEW.region, NEW.currency, NEW.set_by_user_id, NEW.set_at)
       IS NOT DISTINCT FROM ROW(OLD.org_id, OLD.region, OLD.currency, OLD.set_by_user_id, OLD.set_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BILLING_REGION_IMMUTABLE' USING ERRCODE = '23514';
END $$;
UPDATE billing_organisation_regions SET usd_per_unit = 1 WHERE currency = 'USD';
GRANT UPDATE (usd_per_unit) ON billing_organisation_regions TO uoa_admin;

ALTER TABLE billing_credit_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_lots FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_lot_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_lot_movements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_credit_lots, billing_credit_lot_movements FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT, UPDATE ON billing_credit_lots TO uoa_admin;
GRANT SELECT, INSERT ON billing_credit_lot_movements TO uoa_admin;
GRANT USAGE, SELECT ON SEQUENCE billing_credit_lot_movements_id_seq TO uoa_admin;
