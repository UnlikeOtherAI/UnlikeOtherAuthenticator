BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Forward metadata only. Existing sources remain NULL, never inferred/backfilled.
ALTER TABLE billing_credit_budget_dispatches ADD COLUMN billing_account_id text REFERENCES billing_stripe_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN billing_scope_epoch timestamptz(3),ADD COLUMN billing_mode_revision integer;
ALTER TABLE billing_organisation_contracts ADD COLUMN billing_account_id text REFERENCES billing_stripe_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN billing_scope_epoch timestamptz(3),ADD COLUMN billing_mode_revision integer;
ALTER TABLE billing_commercial_adjustments ADD COLUMN billing_account_id text REFERENCES billing_stripe_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN billing_scope_epoch timestamptz(3),ADD COLUMN billing_mode_revision integer;
ALTER TABLE billing_commercial_adjustments DROP CONSTRAINT billing_commercial_adjustments_org_id_fkey,
  DROP CONSTRAINT billing_commercial_adjustments_team_id_fkey,
  ADD CONSTRAINT billing_commercial_adjustments_org_id_fkey FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT billing_commercial_adjustments_team_id_fkey FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE RESTRICT;
-- Do not repair or erase old orphan references. New captures are checked and
-- current restricted references participate in the existing deletion inventory.
ALTER TABLE billing_credit_budget_dispatches
  ADD CONSTRAINT billing_budget_org_fkey FOREIGN KEY(org_id) REFERENCES organisations(id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT billing_budget_team_fkey FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT billing_budget_user_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;

CREATE FUNCTION guard_billing_financial_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb:=to_jsonb(NEW); v_old jsonb; v_org text:=v->>'org_id'; v_live boolean; v_source_account text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BILLING_FINANCIAL_SOURCE_BINDING_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' THEN
    v_old:=to_jsonb(OLD);
    IF v->>'billing_account_id' IS DISTINCT FROM v_old->>'billing_account_id'
      OR v->>'billing_scope_epoch' IS DISTINCT FROM v_old->>'billing_scope_epoch'
      OR v->>'billing_mode_revision' IS DISTINCT FROM v_old->>'billing_mode_revision' THEN
      RAISE EXCEPTION 'BILLING_FINANCIAL_SOURCE_BINDING_IMMUTABLE'; END IF;
    -- Existing captured recovery and deactivation remain on the stored tuple.
    IF TG_TABLE_NAME<>'billing_organisation_contracts' OR v->>'status'<>'ACTIVE' THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='billing_credit_budget_dispatches' THEN
    IF (v->>'is_legacy')::boolean THEN
      SELECT c.account_id INTO v_source_account FROM billing_prepaid_reservations r
        JOIN billing_credit_accounts c ON c.id=r.credit_account_id WHERE r.dispatch_id=v->>'dispatch_id'
          AND r.org_id=v_org AND r.team_id=v->>'team_id' AND r.user_id=v->>'user_id';
      IF v_source_account IS NULL OR v_source_account IS DISTINCT FROM v->>'billing_account_id'
        OR v->>'billing_scope_epoch' IS NOT NULL OR v->>'billing_mode_revision' IS NOT NULL THEN
        RAISE EXCEPTION 'BILLING_CAPTURED_ACCOUNT_RECONCILIATION_REQUIRED'; END IF;
      RETURN NEW;
    END IF;
    -- A frozen FREE dispatch creates no money and needs no Stripe configuration.
    IF v->>'tariff_mode'='FREE' AND v->>'billing_account_id' IS NULL THEN RETURN NEW; END IF;
  END IF;
  PERFORM id FROM organisations WHERE id=v_org AND lifecycle_status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_ORGANISATION_NOT_AVAILABLE'; END IF;
  INSERT INTO billing_organisation_mode_locks(org_id) VALUES(v_org) ON CONFLICT(org_id)
    DO UPDATE SET generation=billing_organisation_mode_locks.generation+1;
  SELECT livemode INTO v_live FROM billing_stripe_accounts WHERE id=v->>'billing_account_id';
  IF v_live IS NULL OR v->>'billing_scope_epoch' IS NULL OR v->>'billing_mode_revision' IS NULL THEN
    RAISE EXCEPTION 'BILLING_CAPTURED_ACCOUNT_RECONCILIATION_REQUIRED'; END IF;
  IF (v->>'billing_scope_epoch')::timestamptz IS DISTINCT FROM
      (SELECT activated_at FROM billing_organisation_scope_cutover WHERE id=1)
    OR (v->>'billing_mode_revision')::integer IS DISTINCT FROM
      COALESCE((SELECT revision FROM billing_organisation_modes WHERE org_id=v_org),0)
    OR COALESCE((SELECT sandbox FROM billing_organisation_modes WHERE org_id=v_org),false)=v_live THEN
    RAISE EXCEPTION 'BILLING_CONTEXT_STALE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_budget_financial_source BEFORE INSERT OR UPDATE OR DELETE ON billing_credit_budget_dispatches
  FOR EACH ROW EXECUTE FUNCTION guard_billing_financial_source_binding();
CREATE TRIGGER billing_contract_financial_source BEFORE INSERT OR UPDATE OR DELETE ON billing_organisation_contracts
  FOR EACH ROW EXECUTE FUNCTION guard_billing_financial_source_binding();
CREATE TRIGGER billing_adjustment_financial_source BEFORE INSERT OR UPDATE OR DELETE ON billing_commercial_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_billing_financial_source_binding();

CREATE FUNCTION guard_billing_manual_invoice_financial_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_contract billing_organisation_contracts%ROWTYPE;
BEGIN
  SELECT * INTO v_contract FROM billing_organisation_contracts WHERE id=NEW.contract_id FOR SHARE;
  IF v_contract.org_id IS DISTINCT FROM NEW.org_id OR v_contract.billing_account_id IS NULL THEN
    RAISE EXCEPTION 'BILLING_CAPTURED_ACCOUNT_RECONCILIATION_REQUIRED'; END IF;
  PERFORM assert_billing_period_mode(v_contract.billing_account_id,NEW.org_id,NULL,NEW.billing_month,v_contract.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER billing_manual_invoice_financial_source BEFORE INSERT ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION guard_billing_manual_invoice_financial_source();

-- Every collector keeps the existing month fence/retry and captured settlement
-- checks, then refuses another account or a genuinely unbound PAYG source.
ALTER FUNCTION assert_billing_period_mode(text,text,text,text,timestamptz) RENAME TO assert_billing_organisation_period_mode;
CREATE FUNCTION assert_billing_period_mode(p_account text,p_org text,p_team text,p_month text,p_source_created timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_billing_organisation_period_mode(p_account,p_org,p_team,p_month,p_source_created);
  IF EXISTS(SELECT 1 FROM billing_paid_usage_liabilities l
    LEFT JOIN billing_credit_budget_dispatches b ON b.dispatch_id=l.dispatch_id
    LEFT JOIN billing_credit_accounts w ON w.id=l.credit_account_id AND w.org_id=l.org_id
    WHERE l.org_id=p_org AND l.billing_month=p_month
      AND NOT (COALESCE(b.tariff_mode,'')='FREE' AND l.rated_microcredits=0)
      AND COALESCE(b.billing_account_id,w.account_id) IS NULL) THEN
    RAISE EXCEPTION 'BILLING_CAPTURED_ACCOUNT_RECONCILIATION_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM billing_paid_usage_liabilities l
    LEFT JOIN billing_credit_budget_dispatches b ON b.dispatch_id=l.dispatch_id
    LEFT JOIN billing_credit_accounts w ON w.id=l.credit_account_id AND w.org_id=l.org_id
    WHERE l.org_id=p_org AND l.billing_month=p_month
      AND NOT (COALESCE(b.tariff_mode,'')='FREE' AND l.rated_microcredits=0)
      AND COALESCE(b.billing_account_id,w.account_id)<>p_account) THEN
    RAISE EXCEPTION 'BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH'; END IF;
END $$;

-- Quiescence includes these sources even when historical evidence is unbound.
ALTER FUNCTION billing_organisation_mode_blockers(text) RENAME TO billing_organisation_mode_provider_blockers;
CREATE FUNCTION billing_organisation_mode_blockers(p_org text) RETURNS TABLE(code text,count bigint) LANGUAGE sql STABLE AS $$
  SELECT code,sum(count)::bigint FROM (
    SELECT * FROM billing_organisation_mode_provider_blockers(p_org)
    UNION ALL SELECT 'financial_source',count(*) FROM billing_organisation_contracts
      WHERE org_id=p_org AND status='ACTIVE'
    UNION ALL SELECT 'financial_source',count(*) FROM billing_commercial_adjustments
      WHERE org_id=p_org AND active AND (ends_at IS NULL OR ends_at>current_timestamp)
    UNION ALL SELECT 'provider_reservation',count(*) FROM billing_credit_budget_dispatches
      WHERE org_id=p_org AND status='ACTIVE' AND tariff_mode<>'FREE'
  ) sources GROUP BY code HAVING sum(count)>0;
$$;

COMMIT;
