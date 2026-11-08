BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Installation evidence, never a money/consent/subscription migration. Counts
-- describe the untouched legacy scope at this immutable cutover instant.
CREATE TABLE billing_organisation_scope_cutover (id integer PRIMARY KEY CHECK(id=1),
  activated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  migration text NOT NULL, legacy_team_wallets bigint NOT NULL,
  legacy_funded_wallets bigint NOT NULL, legacy_consents bigint NOT NULL,
  legacy_team_subscriptions bigint NOT NULL, legacy_team_policies bigint NOT NULL);
INSERT INTO billing_organisation_scope_cutover(id,migration,legacy_team_wallets,
  legacy_funded_wallets,legacy_consents,legacy_team_subscriptions,legacy_team_policies)
SELECT 1,'20261107230000_organisation_financial_scope',
  (SELECT count(*) FROM billing_credit_accounts WHERE team_id IS NOT NULL),
  (SELECT count(*) FROM billing_credit_accounts WHERE team_id IS NOT NULL AND balance_microcredits <> 0),
  (SELECT count(*) FROM billing_credit_accounts WHERE team_id IS NOT NULL AND auto_top_up_consent_revision_id IS NOT NULL),
  (SELECT count(*) FROM billing_stripe_subscriptions WHERE team_id IS NOT NULL),
  (SELECT count(*) FROM billing_team_modes);
CREATE TABLE billing_organisation_modes (org_id text PRIMARY KEY REFERENCES organisations(id) ON DELETE RESTRICT,
  sandbox boolean NOT NULL DEFAULT false, revision integer NOT NULL CHECK(revision>0),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp());
CREATE TABLE billing_organisation_mode_events (org_id text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision>0), sandbox boolean NOT NULL,
  effective_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(org_id,revision));
CREATE TABLE billing_organisation_mode_locks(org_id text PRIMARY KEY REFERENCES organisations(id) ON DELETE RESTRICT,
  generation bigint NOT NULL DEFAULT 1);
DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['billing_organisation_scope_cutover','billing_organisation_modes','billing_organisation_mode_events','billing_organisation_mode_locks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
    EXECUTE format('CREATE POLICY deny_all ON %I FOR ALL USING(false) WITH CHECK(false)',n);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,uoa_app',n);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO uoa_admin',n);
  END LOOP;
END $$;
ALTER TABLE billing_customer_action_intents ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE billing_cancellation_intents ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE billing_recurring_addon_checkouts ALTER COLUMN requested_team_id DROP NOT NULL;
ALTER TABLE billing_recurring_addon_cancellation_intents ALTER COLUMN requested_team_id DROP NOT NULL;
GRANT UPDATE ON billing_organisation_modes TO uoa_admin;
GRANT UPDATE ON billing_organisation_mode_locks TO uoa_admin;
CREATE TRIGGER billing_organisation_mode_locks_no_delete BEFORE DELETE ON billing_organisation_mode_locks
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();
CREATE TRIGGER billing_organisation_cutover_immutable BEFORE UPDATE OR DELETE ON billing_organisation_scope_cutover
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();
CREATE TRIGGER billing_organisation_events_immutable BEFORE UPDATE OR DELETE ON billing_organisation_mode_events
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();
CREATE TRIGGER billing_organisation_modes_no_delete BEFORE DELETE ON billing_organisation_modes
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();
CREATE TRIGGER billing_team_modes_retired BEFORE INSERT OR UPDATE ON billing_team_modes
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();

CREATE FUNCTION billing_organisation_mode_blockers(p_org text)
RETURNS TABLE(code text, count bigint) LANGUAGE sql STABLE AS $$
  WITH accounts AS (
    SELECT id FROM billing_credit_accounts WHERE org_id = p_org
  ), blockers AS (
    SELECT 'organisation_billing'::text AS code, count(*) FROM billing_org_responsibilities
      WHERE org_id = p_org AND active
    UNION ALL SELECT 'funded_balance', count(*) FROM billing_credit_accounts
      WHERE id IN (SELECT id FROM accounts) AND balance_microcredits <> 0
    UNION ALL SELECT 'automatic_top_up', count(*) FROM billing_credit_accounts
      WHERE id IN (SELECT id FROM accounts) AND auto_top_up_consent_revision_id IS NOT NULL
    UNION ALL SELECT 'subscription', count(*) FROM billing_stripe_subscriptions
      WHERE org_id = p_org
        AND status NOT IN ('canceled', 'incomplete_expired')
    UNION ALL SELECT 'subscription_checkout', count(*) FROM billing_stripe_checkout_sessions
      WHERE org_id = p_org
        AND status NOT IN ('expired', 'complete')
    UNION ALL SELECT 'credit_payment', count(*) FROM billing_credit_top_up_checkouts
      WHERE credit_account_id IN (SELECT id FROM accounts) AND status NOT IN ('COMPLETE', 'EXPIRED')
    UNION ALL SELECT 'card_setup', count(*) FROM billing_credit_setup_checkouts
      WHERE credit_account_id IN (SELECT id FROM accounts) AND status NOT IN ('COMPLETE', 'EXPIRED', 'ABANDONED')
    UNION ALL SELECT 'automatic_payment', count(*) FROM billing_credit_auto_top_up_attempts
      WHERE credit_account_id IN (SELECT id FROM accounts)
        AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED')
    UNION ALL SELECT 'addon_subscription', count(*) FROM billing_recurring_addon_subscriptions
      WHERE org_id = p_org
        AND status NOT IN ('canceled', 'incomplete_expired')
    UNION ALL SELECT 'addon_checkout', count(*) FROM billing_recurring_addon_checkouts
      WHERE org_id = p_org
        AND status NOT IN ('COMPLETE', 'EXPIRED')
    UNION ALL SELECT 'provider_reservation', count(*) FROM billing_prepaid_reservations
      WHERE org_id = p_org AND status = 'ACTIVE'
    UNION ALL SELECT 'sms_reservation', count(*) FROM billing_sms_reservations
      WHERE org_id = p_org AND state IN ('reserved', 'dispatching', 'uncertain', 'reconciliation')
    UNION ALL SELECT 'sms_standing_funding', count(*) FROM billing_sms_standing_holds
      WHERE org_id = p_org AND state = 'active'
    UNION ALL SELECT 'voice_reservation', count(*) FROM billing_voice_reservations
      WHERE org_id = p_org AND state IN ('reserved', 'dispatching', 'uncertain', 'reconciliation')
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_voice_grants
      WHERE org_id = p_org AND revoked_at IS NULL
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_sms_dispatch_grants
      WHERE org_id = p_org AND revoked_at IS NULL
    UNION ALL SELECT 'funding_authorization', count(*) FROM billing_sms_quotes
      WHERE org_id = p_org AND expires_at > current_timestamp
    UNION ALL SELECT 'monthly_usage', count(*) FROM billing_credit_usage_settlements
      WHERE credit_account_id IN (SELECT id FROM accounts)
        AND billing_month = to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM')
    UNION ALL SELECT 'monthly_usage', count(*) FROM billing_paid_usage_liabilities
      WHERE org_id = p_org
        AND billing_month = to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM')
    UNION ALL SELECT 'monthly_usage', count(*) FROM billing_credit_portfolio_snapshots
      WHERE org_id = p_org
        AND billing_month = to_char(current_timestamp AT TIME ZONE 'UTC', 'YYYY-MM')
    UNION ALL SELECT 'provider_reservation', count(*) FROM billing_ledger_dispatch_decisions d
      WHERE d.org_id = p_org AND d.status = 'PAY_AS_YOU_GO'
        AND NOT EXISTS (SELECT 1 FROM billing_ledger_dispatch_releases r WHERE r.dispatch_id = d.dispatch_id)
        AND NOT EXISTS (SELECT 1 FROM billing_paid_usage_liabilities l WHERE l.dispatch_id = d.dispatch_id)
  ) SELECT code, sum(count)::bigint FROM blockers WHERE count > 0 AND code <> 'organisation_billing' GROUP BY code;
$$;

CREATE FUNCTION guard_billing_organisation_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM organisations WHERE id=NEW.org_id AND lifecycle_status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_ORGANISATION_NOT_AVAILABLE'; END IF;
  INSERT INTO billing_organisation_mode_locks(org_id) VALUES(NEW.org_id) ON CONFLICT(org_id)
    DO UPDATE SET generation=billing_organisation_mode_locks.generation+1;
  IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND
    (NEW.org_id<>OLD.org_id OR NEW.revision<>OLD.revision+1) THEN
    RAISE EXCEPTION 'BILLING_ORGANISATION_MODE_REVISION_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM billing_organisation_mode_blockers(NEW.org_id)) THEN
    RAISE EXCEPTION 'BILLING_ORGANISATION_MODE_BLOCKED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_organisation_modes_guard BEFORE INSERT OR UPDATE ON billing_organisation_modes
  FOR EACH ROW EXECUTE FUNCTION guard_billing_organisation_mode_change();
CREATE FUNCTION record_billing_organisation_mode_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_organisation_mode_events(org_id,revision,sandbox) VALUES(NEW.org_id,NEW.revision,NEW.sandbox);
  RETURN NEW;
END $$;
CREATE TRIGGER billing_organisation_modes_history AFTER INSERT OR UPDATE ON billing_organisation_modes
  FOR EACH ROW EXECUTE FUNCTION record_billing_organisation_mode_event();

DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['billing_stripe_checkout_sessions','billing_credit_top_up_checkouts',
    'billing_credit_setup_checkouts','billing_recurring_addon_checkouts'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN billing_scope_epoch timestamptz(3)',n);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION guard_billing_captured_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_mode_team_id IS DISTINCT FROM OLD.billing_mode_team_id OR
    NEW.billing_mode_revision IS DISTINCT FROM OLD.billing_mode_revision OR
    NEW.billing_scope_epoch IS DISTINCT FROM OLD.billing_scope_epoch THEN
    RAISE EXCEPTION 'BILLING_MODE_EVIDENCE_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION assert_billing_period_mode(text,text,text,text,timestamptz) RENAME TO assert_billing_legacy_period_mode;
CREATE FUNCTION assert_billing_period_mode(p_account text,p_org text,p_team text,p_month text,p_source_created timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_start timestamptz; v_end timestamptz; v_epoch timestamptz; v_live boolean;
BEGIN
  v_start := (p_month || '-01')::date::timestamp AT TIME ZONE 'UTC';
  v_end := ((p_month || '-01')::date + interval '1 month') AT TIME ZONE 'UTC';
  SELECT activated_at INTO STRICT v_epoch FROM billing_organisation_scope_cutover WHERE id=1;
  IF v_end<=v_epoch THEN
    PERFORM assert_billing_legacy_period_mode(p_account,p_org,p_team,p_month,p_source_created); RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('uoa-billing-month:' || p_org || ':' || p_month,0));
  INSERT INTO billing_mode_period_locks(org_id,billing_month) VALUES(p_org,p_month)
    ON CONFLICT(org_id,billing_month) DO UPDATE SET generation=billing_mode_period_locks.generation+1;
  PERFORM id FROM organisations WHERE id=p_org FOR SHARE;
  IF v_epoch>=v_start AND v_epoch<v_end OR EXISTS(SELECT 1 FROM billing_organisation_mode_events
    WHERE org_id=p_org AND effective_at>=v_start AND effective_at<v_end) THEN
    RAISE EXCEPTION 'BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED'; END IF;
  SELECT livemode INTO STRICT v_live FROM billing_stripe_accounts WHERE id=p_account;
  IF COALESCE((SELECT sandbox FROM billing_organisation_mode_events WHERE org_id=p_org AND effective_at<=v_start
    ORDER BY revision DESC LIMIT 1),false)=v_live THEN
    RAISE EXCEPTION 'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH'; END IF;
  IF EXISTS(SELECT 1 FROM billing_credit_usage_settlements u JOIN billing_credit_accounts c ON c.id=u.credit_account_id
    WHERE c.org_id=p_org AND u.billing_month=p_month AND u.account_id<>p_account)
    OR EXISTS(SELECT 1 FROM billing_stripe_usage_exports e JOIN billing_stripe_subscriptions s ON s.id=e.subscription_id
      WHERE s.org_id=p_org AND e.billing_month=p_month AND e.account_id<>p_account) THEN
    RAISE EXCEPTION 'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH'; END IF;
  IF p_source_created IS NULL OR p_source_created>=v_end THEN
    RAISE EXCEPTION 'BILLING_MODE_HISTORY_RECONCILIATION_REQUIRED'; END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_billing_effect_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb := to_jsonb(NEW); v_account text; v_org text; v_team text; v_live boolean;
  v_source_time timestamptz;
BEGIN
  v_account := v->>'account_id'; v_org := v->>'org_id'; v_team := v->>'team_id';
  IF v->>'credit_account_id' IS NOT NULL THEN
    SELECT account_id, org_id, COALESCE(v_team, team_id) INTO v_account, v_org, v_team
      FROM billing_credit_accounts WHERE id = v->>'credit_account_id';
  END IF;
  PERFORM id FROM organisations WHERE id = v_org FOR SHARE;
  -- Force a stale Serializable capture to retry after a competing mode change.
  INSERT INTO billing_organisation_mode_locks(org_id) VALUES(v_org) ON CONFLICT(org_id)
    DO UPDATE SET generation=billing_organisation_mode_locks.generation+1;
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
      (v_live AND v_source_time < (SELECT activated_at FROM billing_mode_cutover WHERE id = 1)) OR EXISTS (SELECT 1 FROM billing_organisation_mode_events e WHERE e.org_id = v_org AND e.effective_at > v_source_time)
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
  -- The organisation epoch distinguishes a new server capture from a pre-cutover
  -- team context, even when both revisions happen to be zero.
  IF v ? 'billing_mode_revision' THEN
    IF v->>'billing_scope_epoch' IS NULL THEN RAISE EXCEPTION 'BILLING_CONTEXT_REQUIRED'; END IF;
    IF (v->>'billing_scope_epoch')::timestamptz IS DISTINCT FROM
      (SELECT activated_at FROM billing_organisation_scope_cutover WHERE id = 1)
      OR (v->>'billing_mode_team_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = v->>'billing_mode_team_id'
        AND t.org_id = v_org AND t.lifecycle_status = 'ACTIVE'))
      OR (v->>'billing_mode_team_id' IS NULL AND NOT EXISTS (
        SELECT 1 FROM billing_customer_action_intents i WHERE i.app_key_id=v->>'app_key_id'
          AND i.actor_jti=v->>'actor_jti' AND i.org_id=v_org AND i.team_id IS NULL AND i.authority_scope='ORGANISATION'))
      OR COALESCE((SELECT revision FROM billing_organisation_modes WHERE org_id = v_org),0)
        <> (v->>'billing_mode_revision')::integer THEN RAISE EXCEPTION 'BILLING_CONTEXT_STALE'; END IF;
  END IF;
  IF COALESCE((SELECT sandbox FROM billing_organisation_modes WHERE org_id = v_org),false) = v_live THEN
    RAISE EXCEPTION 'BILLING_ORGANISATION_MODE_CHANGED';
  END IF;
  -- Attribution may still name a team; the payer/customer may not be a team.
  IF v->>'credit_account_id' IS NOT NULL AND EXISTS (SELECT 1 FROM billing_credit_accounts
    WHERE id = v->>'credit_account_id' AND (scope <> 'ORGANISATION' OR team_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'BILLING_ORGANISATION_SCOPE_REQUIRED';
  END IF;
  IF TG_TABLE_NAME = 'billing_stripe_checkout_sessions'
    AND (v->>'scope' <> 'ORGANISATION' OR v_team IS NOT NULL OR v->>'scope_key' <> v_org) THEN
    RAISE EXCEPTION 'BILLING_ORGANISATION_SCOPE_REQUIRED';
  END IF;
  IF TG_TABLE_NAME = 'billing_recurring_addon_checkouts' AND NOT EXISTS (
    SELECT 1 FROM billing_stripe_customers c WHERE c.id=v->>'customer_id'
      AND c.org_id=v_org AND c.account_id=v_account AND c.scope='ORGANISATION' AND c.team_id IS NULL
  ) THEN RAISE EXCEPTION 'BILLING_ORGANISATION_SCOPE_REQUIRED'; END IF;
  IF TG_TABLE_NAME IN ('billing_sms_reservations','billing_sms_standing_holds','billing_voice_reservations')
    AND (v_source_time IS NULL OR v_source_time <
      (SELECT activated_at FROM billing_organisation_scope_cutover WHERE id = 1)
      OR EXISTS (SELECT 1 FROM billing_organisation_mode_events WHERE org_id = v_org AND effective_at > v_source_time)) THEN
    RAISE EXCEPTION 'BILLING_CONTEXT_STALE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "billing_customer_action_intent_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  app_key_row "billing_app_keys"%ROWTYPE;
  service_row "billing_services"%ROWTYPE;
  user_row "users"%ROWTYPE;
  organisation_row "organisations"%ROWTYPE;
  team_row "teams"%ROWTYPE;
  org_member_row "org_members"%ROWTYPE;
  team_member_row "team_members"%ROWTYPE;
  managed_team boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'customer billing action intents are append-only'
      USING ERRCODE = '23514';
  END IF;

  -- This deterministic lock order is the linearization point against app-key
  -- revocation and exact actor/workspace membership or role changes.
  SELECT * INTO app_key_row
  FROM "billing_app_keys"
  WHERE "id" = NEW."app_key_id"
  FOR UPDATE;
  SELECT * INTO service_row
  FROM "billing_services"
  WHERE "id" = NEW."service_id"
  FOR UPDATE;
  SELECT * INTO user_row
  FROM "users"
  WHERE "id" = NEW."requested_by_user_id"
  FOR UPDATE;
  SELECT * INTO organisation_row
  FROM "organisations"
  WHERE "id" = NEW."org_id"
  FOR UPDATE;
  SELECT * INTO team_row
  FROM "teams"
  WHERE "id" = NEW."team_id"
  FOR UPDATE;
  SELECT * INTO org_member_row
  FROM "org_members"
  WHERE "org_id" = NEW."org_id"
    AND "user_id" = NEW."requested_by_user_id"
  FOR UPDATE;
  SELECT * INTO team_member_row
  FROM "team_members"
  WHERE "team_id" = NEW."team_id"
    AND "user_id" = NEW."requested_by_user_id"
  FOR UPDATE;

  -- Lock every qualifying membership and its active team before deciding. The
  -- selected membership remains a separate mandatory admission requirement.
  PERFORM tm.id FROM team_members tm JOIN teams t ON t.id = tm.team_id
    WHERE t.org_id = NEW.org_id AND t.lifecycle_status = 'ACTIVE'
      AND tm.user_id = NEW.requested_by_user_id AND tm.status = 'ACTIVE'
      AND tm.team_role IN ('owner','admin') ORDER BY t.id FOR UPDATE OF tm,t;
  SELECT EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.id = tm.team_id
    WHERE t.org_id = NEW.org_id AND t.lifecycle_status = 'ACTIVE'
      AND tm.user_id = NEW.requested_by_user_id AND tm.status = 'ACTIVE'
      AND tm.team_role IN ('owner','admin')) INTO managed_team;

  IF app_key_row."id" IS NULL
     OR app_key_row."service_id" IS DISTINCT FROM NEW."service_id"
     OR app_key_row."purpose" IS DISTINCT FROM 'CUSTOMER_LIFECYCLE'
     OR app_key_row."revoked_at" IS NOT NULL
     OR (app_key_row."expires_at" IS NOT NULL
         AND app_key_row."expires_at" <= (clock_timestamp() AT TIME ZONE 'UTC'))
     OR service_row."id" IS NULL
     OR service_row."active" IS DISTINCT FROM TRUE
     OR user_row."id" IS NULL
     OR user_row."token_version" IS DISTINCT FROM NEW."actor_token_version"
     OR NEW."actor_expires_at" <= (clock_timestamp() AT TIME ZONE 'UTC')
     OR organisation_row."id" IS NULL
     OR organisation_row."lifecycle_status" IS DISTINCT FROM 'ACTIVE'
     OR (NEW.team_id IS NOT NULL AND team_row."lifecycle_status" IS DISTINCT FROM 'ACTIVE')
     OR user_row."lifecycle_status" IS DISTINCT FROM 'ACTIVE'
     OR (NEW.team_id IS NOT NULL AND team_row."org_id" IS DISTINCT FROM NEW."org_id")
     OR org_member_row."status" IS DISTINCT FROM 'ACTIVE'
     OR (NEW.team_id IS NOT NULL AND team_member_row."status" IS DISTINCT FROM 'ACTIVE'
       AND NOT (organisation_row.owner_id=NEW.requested_by_user_id OR org_member_row.role IN ('owner','admin')))
     OR (NEW.team_id IS NULL AND (NEW.authority_scope<>'ORGANISATION' OR NOT (
       organisation_row.owner_id=NEW.requested_by_user_id OR org_member_row.role IN ('owner','admin'))))
     OR NOT (
       organisation_row."owner_id" = NEW."requested_by_user_id"
       OR org_member_row."role" IN ('owner', 'admin')
       OR (NEW.team_id IS NOT NULL AND managed_team)
     ) THEN
    RAISE EXCEPTION 'customer billing action intent lacks current exact authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Historical responsibility records remain evidence, never an opt-out of the
-- new financial scope. The API refuses assume/release; direct toggles also fail.
CREATE TRIGGER billing_org_responsibility_retired BEFORE INSERT OR UPDATE OR DELETE ON billing_org_responsibilities
  FOR EACH ROW EXECUTE FUNCTION guard_billing_mode_evidence();

-- Old team sources can recover captured historical periods. They cannot acquire
-- the organisation's new monthly usage after this scope cutover.
CREATE FUNCTION guard_billing_monthly_organisation_payer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_team text; v_scope text; v_month text := to_jsonb(NEW)->>'billing_month';
BEGIN
  IF TG_TABLE_NAME='billing_credit_usage_settlements' THEN
    SELECT team_id,scope::text INTO v_team,v_scope FROM billing_credit_accounts WHERE id=NEW.credit_account_id;
  ELSE
    SELECT team_id,scope::text INTO v_team,v_scope FROM billing_stripe_subscriptions WHERE id=NEW.subscription_id;
  END IF;
  IF v_month >= (SELECT to_char(activated_at AT TIME ZONE 'UTC','YYYY-MM')
    FROM billing_organisation_scope_cutover WHERE id=1) AND (v_team IS NOT NULL OR v_scope<>'ORGANISATION') THEN
    RAISE EXCEPTION 'BILLING_ORGANISATION_SCOPE_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_credit_monthly_org_payer BEFORE INSERT ON billing_credit_usage_settlements
  FOR EACH ROW EXECUTE FUNCTION guard_billing_monthly_organisation_payer();
CREATE TRIGGER billing_stripe_monthly_org_payer BEFORE INSERT ON billing_stripe_usage_exports
  FOR EACH ROW EXECUTE FUNCTION guard_billing_monthly_organisation_payer();

CREATE OR REPLACE FUNCTION billing_assert_credit_scope_manager(expected_org_id text,expected_team_id text,expected_user_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM users WHERE id=expected_user_id AND lifecycle_status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
  PERFORM id FROM organisations WHERE id=expected_org_id AND lifecycle_status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
  PERFORM id FROM org_members WHERE org_id=expected_org_id AND user_id=expected_user_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
  PERFORM tm.id FROM team_members tm JOIN teams t ON t.id=tm.team_id
    WHERE t.org_id=expected_org_id AND t.lifecycle_status='ACTIVE' AND tm.user_id=expected_user_id
      AND tm.status='ACTIVE' AND tm.team_role IN ('owner','admin') ORDER BY t.id FOR SHARE OF tm,t;
  IF NOT EXISTS(SELECT 1 FROM org_members m JOIN organisations o ON o.id=m.org_id
    WHERE m.org_id=expected_org_id AND m.user_id=expected_user_id AND m.status='ACTIVE'
      AND (m.role IN ('owner','admin') OR o.owner_id=expected_user_id OR EXISTS(
        SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE t.org_id=expected_org_id
          AND t.lifecycle_status='ACTIVE' AND tm.user_id=expected_user_id AND tm.status='ACTIVE' AND tm.team_role IN ('owner','admin'))))
    THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
END $$;

COMMIT;
