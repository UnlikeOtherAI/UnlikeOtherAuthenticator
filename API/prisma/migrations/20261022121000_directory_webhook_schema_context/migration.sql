-- Bind SECURITY DEFINER lookups to the migration's own trusted schema,
-- including isolated verification schemas, instead of the caller search path.
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.enqueue_directory_person() SET search_path TO %I, pg_temp',
    current_schema(), current_schema());
END $$;
