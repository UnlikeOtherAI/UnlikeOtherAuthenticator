-- CREATE OR REPLACE clears a function's configuration unless it is supplied
-- again. Pin every privileged seat function after all membership definitions.
-- Explicit pg_temp last also prevents implicit temporary-table precedence.
DO $$
DECLARE function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'billing_seat_touch_org(text)', 'billing_seat_touch_change()',
    'billing_seat_eligible(text,text)', 'billing_seat_refresh_org(text)',
    'billing_seat_refresh_change()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, pg_temp',
      function_signature, current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_signature);
  END LOOP;
END $$;
