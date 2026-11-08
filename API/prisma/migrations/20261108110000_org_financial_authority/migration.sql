BEGIN;

-- Only current organisation managers may manage the one organisation payer.
-- Retained rows, captured recovery and ordinary paid runtime dispatch authority
-- are unchanged. Team-only administrators use a separate read-only surface.
CREATE OR REPLACE FUNCTION billing_assert_credit_scope_manager(
  expected_org_id text, expected_team_id text, expected_user_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM users WHERE id=expected_user_id AND lifecycle_status='ACTIVE'
    AND (account_expires_at IS NULL OR account_expires_at > (clock_timestamp() AT TIME ZONE 'UTC')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
  PERFORM id FROM organisations WHERE id=expected_org_id AND lifecycle_status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
  PERFORM id FROM org_members WHERE org_id=expected_org_id AND user_id=expected_user_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM org_members m JOIN organisations o ON o.id=m.org_id
    WHERE m.org_id=expected_org_id AND m.user_id=expected_user_id AND m.status='ACTIVE'
      AND (m.role IN ('owner','admin') OR o.owner_id=expected_user_id)) THEN
    RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514';
  END IF;
  -- Organisation managers select any ACTIVE same-org team without membership.
  IF expected_team_id IS NOT NULL THEN
    PERFORM id FROM teams WHERE id=expected_team_id AND org_id=expected_org_id AND lifecycle_status='ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MANAGER_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
END $$;

-- The existing intent guard still validates and locks the exact app, service,
-- actor epoch, org and selected team. Add the narrower financial authority after
-- that guard. Runtime telephone grants retain their distinct product authority;
-- they are not customer billing reads or wallet-management actions.
CREATE FUNCTION guard_billing_customer_financial_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation NOT IN ('voice_dispatch_grant','sms_dispatch_grant','sms_inbound_fund') THEN
    PERFORM billing_assert_credit_scope_manager(NEW.org_id,NEW.team_id,NEW.requested_by_user_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER z_billing_customer_financial_authority BEFORE INSERT ON billing_customer_action_intents
  FOR EACH ROW EXECUTE FUNCTION guard_billing_customer_financial_authority();

COMMIT;
