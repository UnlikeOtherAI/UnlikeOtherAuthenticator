BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Keep the existing provider guard and every forward financial source when
-- adding browser reservations. No captured account or history is rewritten.
CREATE OR REPLACE FUNCTION billing_organisation_mode_blockers(p_org text)
RETURNS TABLE(code text, count bigint) LANGUAGE sql STABLE AS $$
  SELECT code, sum(count)::bigint FROM (
    SELECT * FROM billing_organisation_mode_provider_blockers(p_org)
    UNION ALL SELECT 'financial_source', count(*) FROM billing_organisation_contracts
      WHERE org_id = p_org AND status = 'ACTIVE'
    UNION ALL SELECT 'financial_source', count(*) FROM billing_commercial_adjustments
      WHERE org_id = p_org AND active AND (ends_at IS NULL OR ends_at > current_timestamp)
    UNION ALL SELECT 'provider_reservation', count(*) FROM billing_credit_budget_dispatches
      WHERE org_id = p_org AND status = 'ACTIVE' AND tariff_mode <> 'FREE'
    UNION ALL SELECT 'browser_reservation', count(*) FROM billing_browser_reservations
      WHERE org_id = p_org AND state IN ('reserved', 'dispatching', 'reconciliation')
  ) sources GROUP BY code HAVING sum(count) > 0;
$$;

COMMIT;
