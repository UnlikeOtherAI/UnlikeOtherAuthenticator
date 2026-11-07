BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE billing_team_modes (
  team_id text PRIMARY KEY REFERENCES teams(id) ON DELETE RESTRICT,
  sandbox boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_team_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_team_modes FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_team_modes_deny ON billing_team_modes FOR ALL USING (false) WITH CHECK (false);

CREATE TABLE billing_mode_cutover (id integer PRIMARY KEY CHECK (id = 1),
  activated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp());
INSERT INTO billing_mode_cutover(id) VALUES (1);
CREATE TABLE billing_team_mode_events (id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0), sandbox boolean NOT NULL,
  effective_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), UNIQUE(team_id, revision));
CREATE INDEX billing_team_mode_events_time ON billing_team_mode_events(team_id, effective_at);
ALTER TABLE billing_mode_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_mode_cutover FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_team_mode_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_team_mode_events FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_mode_cutover_deny ON billing_mode_cutover FOR ALL USING (false) WITH CHECK (false);
CREATE POLICY billing_team_mode_events_deny ON billing_team_mode_events FOR ALL USING (false) WITH CHECK (false);
CREATE FUNCTION guard_billing_mode_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'BILLING_MODE_EVIDENCE_IMMUTABLE'; END; $$;
CREATE TRIGGER billing_mode_cutover_immutable BEFORE UPDATE OR DELETE ON billing_mode_cutover
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();
CREATE TRIGGER billing_team_mode_events_immutable BEFORE UPDATE OR DELETE ON billing_team_mode_events
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();
CREATE TRIGGER billing_team_modes_no_delete BEFORE DELETE ON billing_team_modes
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();

ALTER TABLE billing_stripe_checkout_sessions ADD COLUMN billing_mode_team_id text,
  ADD COLUMN billing_mode_revision integer NOT NULL DEFAULT 0;
ALTER TABLE billing_credit_top_up_checkouts ADD COLUMN billing_mode_team_id text,
  ADD COLUMN billing_mode_revision integer NOT NULL DEFAULT 0;
ALTER TABLE billing_credit_setup_checkouts ADD COLUMN billing_mode_team_id text,
  ADD COLUMN billing_mode_revision integer NOT NULL DEFAULT 0;
ALTER TABLE billing_recurring_addon_checkouts ADD COLUMN billing_mode_team_id text,
  ADD COLUMN billing_mode_revision integer NOT NULL DEFAULT 0;

CREATE FUNCTION guard_billing_captured_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_mode_team_id IS DISTINCT FROM OLD.billing_mode_team_id OR
    NEW.billing_mode_revision IS DISTINCT FROM OLD.billing_mode_revision THEN
    RAISE EXCEPTION 'BILLING_MODE_EVIDENCE_IMMUTABLE';
  END IF;
  RETURN NEW;
END; $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_stripe_checkout_sessions',
    'billing_credit_top_up_checkouts', 'billing_credit_setup_checkouts', 'billing_recurring_addon_checkouts'] LOOP
    EXECUTE format('CREATE TRIGGER billing_captured_mode_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_billing_captured_mode()', table_name);
  END LOOP;
END $$;

-- Deliberately no backfill: a missing operator policy means live. Financial
-- accounts, customers, consents, objects and append-only evidence never move.
CREATE FUNCTION billing_team_mode_blockers(p_org text, p_team text)
RETURNS TABLE(code text, count bigint) LANGUAGE sql STABLE AS $$
  WITH accounts AS (
    SELECT id FROM billing_credit_accounts WHERE org_id = p_org AND (team_id = p_team OR team_id IS NULL)
  ), blockers AS (
    SELECT 'organisation_billing'::text AS code, count(*) FROM billing_org_responsibilities
      WHERE org_id = p_org AND active
    UNION ALL SELECT 'funded_balance', count(*) FROM billing_credit_accounts
      WHERE id IN (SELECT id FROM accounts) AND balance_microcredits <> 0
    UNION ALL SELECT 'automatic_top_up', count(*) FROM billing_credit_accounts
      WHERE id IN (SELECT id FROM accounts) AND auto_top_up_consent_revision_id IS NOT NULL
    UNION ALL SELECT 'subscription', count(*) FROM billing_stripe_subscriptions
      WHERE org_id = p_org AND (team_id = p_team OR team_id IS NULL)
        AND status NOT IN ('canceled', 'incomplete_expired')
    UNION ALL SELECT 'subscription_checkout', count(*) FROM billing_stripe_checkout_sessions
      WHERE org_id = p_org AND (team_id = p_team OR team_id IS NULL)
        AND status NOT IN ('expired', 'complete')
    UNION ALL SELECT 'credit_payment', count(*) FROM billing_credit_top_up_checkouts
      WHERE credit_account_id IN (SELECT id FROM accounts) AND status NOT IN ('COMPLETE', 'EXPIRED')
    UNION ALL SELECT 'card_setup', count(*) FROM billing_credit_setup_checkouts
      WHERE credit_account_id IN (SELECT id FROM accounts) AND status NOT IN ('COMPLETE', 'EXPIRED', 'ABANDONED')
    UNION ALL SELECT 'automatic_payment', count(*) FROM billing_credit_auto_top_up_attempts
      WHERE credit_account_id IN (SELECT id FROM accounts)
        AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED')
    UNION ALL SELECT 'addon_subscription', count(*) FROM billing_recurring_addon_subscriptions
      WHERE org_id = p_org AND (team_id = p_team OR team_id IS NULL)
        AND status NOT IN ('canceled', 'incomplete_expired')
    UNION ALL SELECT 'addon_checkout', count(*) FROM billing_recurring_addon_checkouts
      WHERE org_id = p_org AND (team_id = p_team OR team_id IS NULL)
        AND status NOT IN ('COMPLETE', 'EXPIRED')
    UNION ALL SELECT 'provider_reservation', count(*) FROM billing_prepaid_reservations
      WHERE org_id = p_org AND team_id = p_team AND status = 'ACTIVE'
    UNION ALL SELECT 'sms_reservation', count(*) FROM billing_sms_reservations
      WHERE org_id = p_org AND team_id = p_team AND state IN ('reserved', 'dispatched', 'needs_review')
    UNION ALL SELECT 'sms_standing_funding', count(*) FROM billing_sms_standing_holds
      WHERE org_id = p_org AND team_id = p_team AND state = 'active'
    UNION ALL SELECT 'voice_reservation', count(*) FROM billing_voice_reservations
      WHERE org_id = p_org AND team_id = p_team AND state IN ('reserved', 'dispatched', 'needs_review')
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_voice_grants
      WHERE org_id = p_org AND team_id = p_team AND revoked_at IS NULL
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_sms_dispatch_grants
      WHERE org_id = p_org AND team_id = p_team AND revoked_at IS NULL
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_sms_quotes
      WHERE org_id = p_org AND expires_at > current_timestamp
    UNION ALL SELECT 'monthly_usage', count(*) FROM billing_credit_usage_settlements
      WHERE credit_account_id IN (SELECT id FROM accounts) AND (team_id = p_team OR team_id IS NULL)
        AND billing_month = to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM')
    UNION ALL SELECT 'monthly_usage', count(*) FROM billing_paid_usage_liabilities
      WHERE org_id = p_org AND team_id = p_team
        AND billing_month = to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM')
    UNION ALL SELECT 'provider_reservation', count(*) FROM billing_ledger_dispatch_decisions d
      WHERE d.org_id = p_org AND d.team_id = p_team AND d.status = 'PAY_AS_YOU_GO'
        AND NOT EXISTS (SELECT 1 FROM billing_ledger_dispatch_releases r WHERE r.dispatch_id = d.dispatch_id)
        AND NOT EXISTS (SELECT 1 FROM billing_paid_usage_liabilities l WHERE l.dispatch_id = d.dispatch_id)
  ) SELECT code, sum(count)::bigint FROM blockers WHERE count > 0 GROUP BY code;
$$;

CREATE FUNCTION guard_billing_team_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_org text;
BEGIN
  SELECT org_id INTO v_org FROM teams WHERE id = NEW.team_id AND lifecycle_status = 'ACTIVE';
  PERFORM id FROM organisations WHERE id = v_org AND lifecycle_status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_TEAM_NOT_AVAILABLE'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.team_id <> OLD.team_id OR NEW.revision <> OLD.revision + 1) THEN
    RAISE EXCEPTION 'BILLING_TEAM_MODE_REVISION_INVALID';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN
    RAISE EXCEPTION 'BILLING_TEAM_MODE_REVISION_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_team_mode_blockers(v_org, NEW.team_id)) THEN
    RAISE EXCEPTION 'BILLING_TEAM_MODE_BLOCKED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_team_modes_guard BEFORE INSERT OR UPDATE ON billing_team_modes
  FOR EACH ROW EXECUTE FUNCTION guard_billing_team_mode_change();
CREATE FUNCTION record_billing_team_mode_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_team_mode_events(id, team_id, revision, sandbox)
    VALUES ('billing-mode:' || NEW.team_id || ':' || NEW.revision, NEW.team_id, NEW.revision, NEW.sandbox);
  RETURN NEW;
END; $$;

CREATE FUNCTION guard_billing_org_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.active THEN RETURN NEW; END IF;
  PERFORM id FROM organisations WHERE id = NEW.org_id FOR UPDATE;
  IF (SELECT count(DISTINCT COALESCE(m.sandbox, false)) FROM teams t
    LEFT JOIN billing_team_modes m ON m.team_id = t.id
    WHERE t.org_id = NEW.org_id AND t.lifecycle_status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'BILLING_ORGANISATION_MODES_MIXED';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER billing_org_mode_guard BEFORE INSERT OR UPDATE ON billing_org_responsibilities
  FOR EACH ROW EXECUTE FUNCTION guard_billing_org_mode();
CREATE TRIGGER billing_team_modes_history AFTER INSERT OR UPDATE ON billing_team_modes
  FOR EACH ROW EXECUTE FUNCTION record_billing_team_mode_event();

-- A Ledger month has no account/mode dimension. Never replay a cumulative
-- total into the newly selected account, or guess an allocation at a cutover.
CREATE FUNCTION assert_billing_period_mode(p_account text, p_org text, p_team text,
  p_month text, p_source_created timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_start timestamptz; v_end timestamptz; v_cutover timestamptz; v_live boolean;
BEGIN
  v_start := (p_month || '-01')::date::timestamp AT TIME ZONE 'UTC';
  v_end := v_start + interval '1 month';
  SELECT activated_at INTO STRICT v_cutover FROM billing_mode_cutover WHERE id = 1;
  SELECT livemode INTO STRICT v_live FROM billing_stripe_accounts WHERE id = p_account;
  PERFORM id FROM organisations WHERE id = p_org FOR SHARE;
  IF v_cutover > v_start AND v_cutover < v_end OR EXISTS (
    SELECT 1 FROM billing_team_mode_events e JOIN teams t ON t.id = e.team_id
    WHERE t.org_id = p_org AND (p_team IS NULL OR t.id = p_team)
      AND e.effective_at > v_start AND e.effective_at < v_end
  ) THEN RAISE EXCEPTION 'BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED'; END IF;
  IF p_source_created IS NULL OR p_source_created >= v_end THEN
    RAISE EXCEPTION 'BILLING_MODE_HISTORY_RECONCILIATION_REQUIRED';
  END IF;
  -- Before this migration, only the existing captured source proves the account.
  -- A new account/subscription cannot acquire a previous month's usage.
  IF v_end <= v_cutover THEN
    IF p_source_created >= v_cutover THEN
      RAISE EXCEPTION 'BILLING_MODE_HISTORY_RECONCILIATION_REQUIRED';
    END IF;
    -- This installation's historical collection was TEST. A long-lived but
    -- unused LIVE account is not evidence that old Ledger usage belongs to it.
    IF v_live AND NOT EXISTS (SELECT 1 FROM billing_stripe_usage_exports e
      JOIN billing_stripe_subscriptions s ON s.id = e.subscription_id
      WHERE e.account_id = p_account AND e.billing_month = p_month AND s.org_id = p_org
        AND (p_team IS NULL OR s.team_id = p_team)) THEN
      RAISE EXCEPTION 'BILLING_MODE_HISTORY_RECONCILIATION_REQUIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM billing_credit_usage_settlements u
      JOIN billing_credit_accounts c ON c.id = u.credit_account_id
      WHERE c.org_id = p_org AND (p_team IS NULL OR u.team_id = p_team)
        AND u.billing_month = p_month AND u.account_id <> p_account) THEN
      RAISE EXCEPTION 'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH';
    END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM teams t WHERE t.org_id = p_org
    AND (p_team IS NULL OR t.id = p_team) AND t.created_at < v_end
    AND COALESCE((SELECT e.sandbox FROM billing_team_mode_events e
      WHERE e.team_id = t.id AND e.effective_at <= v_start
      ORDER BY e.revision DESC LIMIT 1), false) = v_live) THEN
    RAISE EXCEPTION 'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH';
  END IF;
END; $$;

-- Capture-time guard, independent of request context. Only new effects use
-- current policy. Updates, reversals and signed late webhooks retain old bindings.
CREATE FUNCTION guard_billing_effect_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb := to_jsonb(NEW); v_account text; v_org text; v_team text; v_live boolean;
  v_source_time timestamptz;
BEGIN
  v_account := v->>'account_id'; v_org := v->>'org_id'; v_team := v->>'team_id';
  IF v->>'credit_account_id' IS NOT NULL THEN
    SELECT account_id, org_id, COALESCE(v_team, team_id) INTO v_account, v_org, v_team
      FROM billing_credit_accounts WHERE id = v->>'credit_account_id';
  END IF;
  PERFORM id FROM organisations WHERE id = v_org FOR SHARE;
  SELECT livemode INTO v_live FROM billing_stripe_accounts WHERE id = v_account;
  IF v_live IS NULL THEN RAISE EXCEPTION 'BILLING_STRIPE_ACCOUNT_REQUIRED'; END IF;
  IF TG_TABLE_NAME IN ('billing_sms_reservations', 'billing_sms_standing_holds', 'billing_voice_reservations') THEN
    IF TG_TABLE_NAME = 'billing_voice_reservations' THEN
      SELECT least(q.created_at, g.created_at) INTO v_source_time FROM billing_voice_quotes q
        JOIN billing_voice_grants g ON g.id = q.grant_id WHERE q.id = v->>'quote_id';
    ELSE
      SELECT created_at INTO v_source_time FROM billing_sms_quotes WHERE id = v->>'quote_id';
    END IF;
    IF v_source_time IS NOT NULL AND (
      (v_live AND v_source_time < (SELECT activated_at FROM billing_mode_cutover WHERE id = 1)) OR
      EXISTS (SELECT 1 FROM billing_team_modes m JOIN teams t ON t.id = m.team_id
        WHERE t.org_id = v_org AND (v_team IS NULL OR t.id = v_team) AND m.updated_at > v_source_time)
    ) THEN RAISE EXCEPTION 'BILLING_CONTEXT_STALE'; END IF;
    IF EXISTS (SELECT 1 FROM billing_sms_number_resources r
      JOIN billing_recurring_addon_catalogs c ON c.offer_id = r.offer_id
      WHERE r.id = v->>'number_id' AND c.account_id <> v_account) THEN
      RAISE EXCEPTION 'BILLING_CONTEXT_STALE';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'billing_stripe_checkout_sessions' AND (
    EXISTS (SELECT 1 FROM billing_stripe_subscriptions s WHERE s.org_id = v_org
      AND s.service_id = v->>'service_id' AND s.account_id <> v_account
      AND (s.team_id IS NULL OR v_team IS NULL OR s.team_id = v_team)
      AND s.status NOT IN ('canceled', 'incomplete_expired')) OR
    EXISTS (SELECT 1 FROM billing_stripe_checkout_sessions s WHERE s.org_id = v_org
      AND s.service_id = v->>'service_id' AND s.account_id <> v_account
      AND (s.team_id IS NULL OR v_team IS NULL OR s.team_id = v_team)
      AND s.status NOT IN ('expired', 'complete'))
  ) THEN RAISE EXCEPTION 'BILLING_HISTORICAL_WORK_PENDING'; END IF;
  IF TG_TABLE_NAME = 'billing_recurring_addon_checkouts' AND (
    EXISTS (SELECT 1 FROM billing_recurring_addon_subscriptions s WHERE s.org_id = v_org
      AND s.service_id = v->>'service_id' AND s.offer_key = v->>'offer_key' AND s.account_id <> v_account
      AND (s.team_id IS NULL OR v_team IS NULL OR s.team_id = v_team)
      AND s.status NOT IN ('canceled', 'incomplete_expired')) OR
    EXISTS (SELECT 1 FROM billing_recurring_addon_checkouts s WHERE s.org_id = v_org
      AND s.service_id = v->>'service_id' AND s.offer_id = v->>'offer_id' AND s.account_id <> v_account
      AND (s.team_id IS NULL OR v_team IS NULL OR s.team_id = v_team)
      AND s.status NOT IN ('EXPIRED', 'COMPLETE'))
  ) THEN RAISE EXCEPTION 'BILLING_HISTORICAL_WORK_PENDING'; END IF;
  IF TG_TABLE_NAME IN ('billing_credit_top_up_checkouts', 'billing_credit_setup_checkouts',
    'billing_credit_auto_top_up_attempts') AND EXISTS (
    SELECT 1 FROM billing_credit_accounts c WHERE c.org_id = v_org AND c.account_id <> v_account
      AND (c.team_id IS NULL OR v_team IS NULL OR c.team_id = v_team) AND (
        EXISTS (SELECT 1 FROM billing_credit_top_up_checkouts s WHERE s.credit_account_id = c.id
          AND s.status NOT IN ('COMPLETE', 'EXPIRED', 'ABANDONED')) OR
        EXISTS (SELECT 1 FROM billing_credit_setup_checkouts s WHERE s.credit_account_id = c.id
          AND s.status NOT IN ('COMPLETE', 'EXPIRED', 'ABANDONED')) OR
        EXISTS (SELECT 1 FROM billing_credit_auto_top_up_attempts s WHERE s.credit_account_id = c.id
          AND s.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED')))
  ) THEN RAISE EXCEPTION 'BILLING_HISTORICAL_WORK_PENDING'; END IF;
  IF v ? 'billing_mode_revision' THEN
    IF v->>'billing_mode_team_id' IS NULL THEN
      -- An old server/client may create work only for an untouched live scope.
      IF NOT v_live OR EXISTS (SELECT 1 FROM teams t JOIN billing_team_modes m ON m.team_id = t.id
        WHERE t.org_id = v_org AND (v_team IS NULL OR t.id = v_team)) THEN
        RAISE EXCEPTION 'BILLING_CONTEXT_REQUIRED';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM teams t LEFT JOIN billing_team_modes m ON m.team_id = t.id
      WHERE t.id = v->>'billing_mode_team_id' AND t.org_id = v_org
        AND (v_team IS NULL OR v_team = t.id)
        AND COALESCE(m.revision, 0) = (v->>'billing_mode_revision')::integer
        AND COALESCE(m.sandbox, false) <> v_live) THEN
      RAISE EXCEPTION 'BILLING_CONTEXT_STALE';
    END IF;
  END IF;
  IF v_team IS NULL THEN
    IF EXISTS (SELECT 1 FROM teams t LEFT JOIN billing_team_modes m ON m.team_id = t.id
      WHERE t.org_id = v_org AND t.lifecycle_status = 'ACTIVE'
        AND COALESCE(m.sandbox, false) = v_live) THEN
      RAISE EXCEPTION 'BILLING_ORGANISATION_MODES_MIXED';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM teams t LEFT JOIN billing_team_modes m ON m.team_id = t.id
    WHERE t.id = v_team AND t.org_id = v_org AND t.lifecycle_status = 'ACTIVE'
      AND COALESCE(m.sandbox, false) <> v_live) THEN
    RAISE EXCEPTION 'BILLING_TEAM_MODE_CHANGED';
  END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'billing_stripe_checkout_sessions', 'billing_credit_top_up_checkouts',
    'billing_credit_setup_checkouts', 'billing_credit_auto_top_up_attempts',
    'billing_recurring_addon_checkouts', 'billing_prepaid_reservations',
    'billing_sms_reservations', 'billing_sms_standing_holds', 'billing_voice_reservations'
  ] LOOP
    EXECUTE format('CREATE TRIGGER billing_effect_mode_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_billing_effect_mode()', table_name);
  END LOOP;
END $$;
COMMIT;
