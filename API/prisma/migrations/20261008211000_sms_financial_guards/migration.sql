SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- A volatile reader sees earlier rows admitted in the same multi-row statement.
CREATE OR REPLACE FUNCTION billing_total_reserved_microcredits(account_id TEXT) RETURNS BIGINT
LANGUAGE SQL VOLATILE AS $$
  SELECT COALESCE(SUM(amount),0)::BIGINT FROM (
    SELECT reserved_microcredits AS amount FROM billing_prepaid_reservations
      WHERE credit_account_id = account_id AND status = 'ACTIVE'
    UNION ALL
    SELECT reserved_microcredits FROM billing_sms_reservations
      WHERE credit_account_id = account_id AND state IN ('reserved','dispatching','uncertain','reconciliation')
    UNION ALL
    SELECT reserved_microcredits FROM billing_sms_standing_holds WHERE credit_account_id = account_id
  ) held
$$;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_sms_fx_snapshots','billing_sms_quotes',
    'billing_sms_number_resources','billing_sms_reservations','billing_sms_standing_holds',
    'billing_sms_inbound_receipts','billing_sms_resource_cancellations',
    'billing_sms_dispatch_cancellations','billing_sms_grant_revocations',
    'billing_sms_standing_retirements','billing_sms_standing_funding','billing_sms_dispatch_grants','billing_sms_route_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, uoa_app', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO uoa_admin', table_name);
  END LOOP;
END $$;

ALTER TABLE billing_sms_route_policies
  ADD CONSTRAINT sms_route_account CHECK (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  ADD CONSTRAINT sms_route_shape CHECK (country ~ '^[A-Z]{2}$' AND direction IN ('inbound','outbound')
    AND currency IN ('USD','EUR') AND additional_per_segment >= 0 AND additional_per_message >= 0
    AND expires_at > accepted_at AND length(trim(source)) > 0 AND length(trim(acceptance_reason)) > 0
    AND evidence_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT sms_route_acceptor FOREIGN KEY (accepted_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE billing_sms_quotes
  ADD CONSTRAINT sms_quote_route_policy FOREIGN KEY (route_policy_id)
    REFERENCES billing_sms_route_policies(id) ON DELETE RESTRICT;
ALTER TABLE billing_sms_standing_holds
  ADD CONSTRAINT sms_standing_quote FOREIGN KEY (quote_id) REFERENCES billing_sms_quotes(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_standing_retirement CHECK ((state = 'active' AND retired_at IS NULL)
    OR (state <> 'active' AND retired_at IS NOT NULL));
ALTER TABLE billing_sms_dispatch_grants
  ADD CONSTRAINT sms_grant_subject FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_grant_number FOREIGN KEY (number_id) REFERENCES billing_sms_number_resources(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_grant_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_grant_org FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_grant_service FOREIGN KEY (service_id) REFERENCES billing_services(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_grant_key FOREIGN KEY (app_key_id) REFERENCES billing_app_keys(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_grant_shape CHECK (max_segments BETWEEN 1 AND 100 AND actor_token_version >= 0
    AND id = idempotency_key);
ALTER TABLE billing_sms_reservations
  ADD CONSTRAINT sms_reservation_grant FOREIGN KEY (grant_id) REFERENCES billing_sms_dispatch_grants(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_reservation_delegation CHECK ((grant_id IS NULL) = (delegate_id IS NULL));
ALTER TABLE billing_sms_standing_funding
  ADD CONSTRAINT sms_funding_hold FOREIGN KEY (hold_id) REFERENCES billing_sms_standing_holds(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_funding_user FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_funding_quote FOREIGN KEY (quote_id) REFERENCES billing_sms_quotes(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_funding_amount CHECK (added_microcredits > 0);
ALTER TABLE billing_sms_inbound_receipts
  ADD CONSTRAINT sms_inbound_quote FOREIGN KEY (quote_id) REFERENCES billing_sms_quotes(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_inbound_org FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_inbound_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sms_inbound_service FOREIGN KEY (service_id) REFERENCES billing_services(id) ON DELETE RESTRICT;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_sms_resource_cancellations','billing_sms_dispatch_cancellations',
    'billing_sms_standing_retirements','billing_sms_grant_revocations','billing_sms_standing_funding'] LOOP
    EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY (service_id) REFERENCES billing_services(id) ON DELETE RESTRICT', table_name);
    EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY (app_key_id) REFERENCES billing_app_keys(id) ON DELETE RESTRICT', table_name);
  END LOOP;
END $$;

CREATE FUNCTION billing_sms_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SMS financial evidence is append-only' USING ERRCODE = '23514'; END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['billing_sms_resource_cancellations','billing_sms_dispatch_cancellations',
    'billing_sms_standing_retirements','billing_sms_grant_revocations','billing_sms_standing_funding','billing_sms_route_policies'] LOOP
    EXECUTE format('CREATE TRIGGER sms_evidence_immutable BEFORE UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION billing_sms_immutable_record()', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['billing_sms_number_resources','billing_sms_reservations',
    'billing_sms_standing_holds','billing_sms_inbound_receipts','billing_sms_dispatch_grants'] LOOP
    EXECUTE format('CREATE TRIGGER sms_no_delete BEFORE DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION billing_sms_immutable_record()', table_name);
  END LOOP;
END $$;

CREATE FUNCTION billing_sms_number_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM billing_sms_resource_cancellations WHERE resource_id = NEW.id) THEN
      RAISE EXCEPTION 'SMS resource was canceled before admission' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['state','recovery_reason','account_sid','phone_number_sid','checkout_id',
      'refund_evidence_digest','refunded_at','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['state','recovery_reason','account_sid','phone_number_sid','checkout_id',
      'refund_evidence_digest','refunded_at','updated_at'])
      OR (OLD.phone_number_sid IS NOT NULL AND (NEW.phone_number_sid IS DISTINCT FROM OLD.phone_number_sid
        OR NEW.account_sid IS DISTINCT FROM OLD.account_sid))
      OR (OLD.state = 'ended' AND NEW.state <> 'ended')
      OR (OLD.state = 'refund_required' AND NEW.state NOT IN ('refund_required','ended'))
      OR (OLD.refund_evidence_digest IS NOT NULL AND
        (NEW.refund_evidence_digest IS DISTINCT FROM OLD.refund_evidence_digest
          OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at)) THEN
      RAISE EXCEPTION 'SMS number financial identity cannot change' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'refund_required' AND NEW.state = 'ended'
      AND (NEW.refund_evidence_digest IS NULL OR NEW.refunded_at IS NULL) THEN
      RAISE EXCEPTION 'SMS refund completion requires verified evidence' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_number_identity BEFORE INSERT OR UPDATE ON billing_sms_number_resources
  FOR EACH ROW EXECUTE FUNCTION billing_sms_number_identity();

CREATE FUNCTION billing_sms_reservation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM billing_sms_dispatch_cancellations WHERE dispatch_id = NEW.dispatch_id) THEN
      RAISE EXCEPTION 'SMS dispatch was canceled before admission' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['state','debited_microcredits','actual_amount','actual_currency',
      'message_sid','dispatch_token_digest','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['state','debited_microcredits','actual_amount','actual_currency',
      'message_sid','dispatch_token_digest','updated_at'])
      OR (OLD.state IN ('settled','released') AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at')
      OR (OLD.message_sid IS NOT NULL AND NEW.message_sid IS DISTINCT FROM OLD.message_sid)
      OR (OLD.dispatch_token_digest IS NOT NULL AND NEW.dispatch_token_digest IS DISTINCT FROM OLD.dispatch_token_digest)
      OR (OLD.state = 'reserved' AND NEW.state NOT IN ('reserved','dispatching','released'))
      OR (OLD.state <> 'reserved' AND NEW.state = 'reserved') THEN
      RAISE EXCEPTION 'SMS dispatch identity or terminal outcome cannot change' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_reservation_identity BEFORE INSERT OR UPDATE ON billing_sms_reservations
  FOR EACH ROW EXECUTE FUNCTION billing_sms_reservation_identity();

CREATE FUNCTION billing_sms_grant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM billing_sms_grant_revocations WHERE grant_id = NEW.id) THEN
      RAISE EXCEPTION 'SMS grant was revoked before admission' USING ERRCODE = '23514';
    END IF;
  ELSIF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'SMS grant authority is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_grant_identity BEFORE INSERT OR UPDATE ON billing_sms_dispatch_grants
  FOR EACH ROW EXECUTE FUNCTION billing_sms_grant_identity();

CREATE FUNCTION billing_sms_standing_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['reserved_microcredits','state','retired_at','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['reserved_microcredits','state','retired_at','updated_at'])
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
    OR (OLD.state <> 'active' AND (NEW.state = 'active' OR NEW.reserved_microcredits > OLD.reserved_microcredits)) THEN
    RAISE EXCEPTION 'SMS standing allocation identity and retirement are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_standing_identity BEFORE UPDATE ON billing_sms_standing_holds
  FOR EACH ROW EXECUTE FUNCTION billing_sms_standing_identity();

CREATE FUNCTION billing_sms_inbound_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['quote_id','actual_amount','actual_currency','consumed_microcredits',
    'uncollected_microcredits','state','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['quote_id','actual_amount','actual_currency','consumed_microcredits',
    'uncollected_microcredits','state','updated_at'])
    OR (OLD.state IN ('funded','uncollected') AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM
      (to_jsonb(OLD) - 'updated_at')) THEN
    RAISE EXCEPTION 'SMS inbound attribution and terminal money cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_inbound_identity BEFORE UPDATE ON billing_sms_inbound_receipts
  FOR EACH ROW EXECUTE FUNCTION billing_sms_inbound_identity();

CREATE FUNCTION billing_sms_standing_not_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_sms_standing_retirements WHERE service_id = NEW.service_id
    AND number_id = NEW.number_id AND allocation_id = NEW.allocation_id) THEN
    RAISE EXCEPTION 'SMS standing allocation was retired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sms_standing_not_retired BEFORE INSERT ON billing_sms_standing_holds
  FOR EACH ROW EXECUTE FUNCTION billing_sms_standing_not_retired();
