-- A shared team credit account can hold consent created through one product
-- while another currently authorized product manager revokes that consent.
-- Keep the exact account, scope, revision, generation, and action-intent proof;
-- the disabling app/service identify the authorized actor, not the old consent.
DO $$
DECLARE
  function_definition TEXT;
  obsolete_clause TEXT;
BEGIN
  obsolete_clause := 'AND disable_event."service_id" = OLD."auto_top_up_service_id"' || E'\n';
  function_definition := pg_get_functiondef(
    format('%I.%I()', current_schema(), 'billing_credit_block_consent_change_during_attempt')::REGPROCEDURE
  );
  IF strpos(function_definition, obsolete_clause) = 0 THEN
    RAISE EXCEPTION 'expected audited disable service comparison was not found';
  END IF;
  EXECUTE replace(function_definition, obsolete_clause, '');

  obsolete_clause := 'AND disable_event."service_id" = NEW."service_id"' || E'\n'
    || '          AND disable_event."app_key_id" = NEW."app_key_id"' || E'\n';
  function_definition := pg_get_functiondef(
    format('%I.%I()', current_schema(), 'billing_credit_auto_top_up_attempt_coherence')::REGPROCEDURE
  );
  IF strpos(function_definition, obsolete_clause) = 0 THEN
    RAISE EXCEPTION 'expected audited disable attempt comparisons were not found';
  END IF;
  EXECUTE replace(function_definition, obsolete_clause, '');
END;
$$;
