-- Commit-scoped hints for every settings writer. Values never enter NOTIFY.
CREATE OR REPLACE FUNCTION notify_user_setting_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.value IS NOT DISTINCT FROM NEW.value THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('uoa_settings_changed', json_build_object(
      'userId', OLD.user_id, 'namespace', OLD.namespace, 'key', OLD.key)::text);
    RETURN OLD;
  END IF;
  PERFORM pg_notify('uoa_settings_changed', json_build_object(
    'userId', NEW.user_id, 'namespace', NEW.namespace, 'key', NEW.key)::text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_settings_changed
AFTER INSERT OR UPDATE OR DELETE ON user_settings
FOR EACH ROW EXECUTE FUNCTION notify_user_setting_change();
