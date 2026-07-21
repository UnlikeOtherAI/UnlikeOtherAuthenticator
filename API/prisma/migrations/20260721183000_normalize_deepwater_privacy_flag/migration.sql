-- The pre-billing DeepWater flag described a user-scoped capability. Paid
-- privacy is team-scoped, so normalize only the exact legacy definition and
-- fail closed if legacy role/user grants would be reinterpreted as billing
-- entitlement.
DO $$
DECLARE
  target_app_id TEXT;
  target_count INTEGER;
  override_count INTEGER;
  current_description TEXT;
  current_default BOOLEAN;
BEGIN
  SELECT COUNT(*), MIN(a."id")
    INTO target_count, target_app_id
  FROM "apps" a
  WHERE a."identifier" = 'deepwater-api'
    AND a."active" = TRUE;

  IF target_count = 0 THEN
    RETURN;
  END IF;
  IF target_count <> 1 THEN
    RAISE EXCEPTION 'DEEPWATER_PRIVACY_APP_AMBIGUOUS';
  END IF;

  SELECT f."description", f."default_state"
    INTO current_description, current_default
  FROM "feature_flag_definitions" f
  WHERE f."app_id" = target_app_id
    AND f."key" = 'can_be_private';

  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF current_default IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'DEEPWATER_PRIVACY_FLAG_DEFAULT_DRIFT';
  END IF;

  SELECT
    (SELECT COUNT(*)
       FROM "feature_flag_role_values" r
      WHERE r."app_id" = target_app_id
        AND r."flag_key" = 'can_be_private')
    +
    (SELECT COUNT(*)
       FROM "feature_flag_user_overrides" u
      WHERE u."app_id" = target_app_id
        AND u."flag_key" = 'can_be_private')
    INTO override_count;

  IF override_count <> 0 THEN
    RAISE EXCEPTION 'DEEPWATER_PRIVACY_LEGACY_OVERRIDES_PRESENT';
  END IF;

  IF current_description =
    'Allows paid private DeepWater research for an entitled team.' THEN
    RETURN;
  END IF;
  IF current_description IS DISTINCT FROM
    'Allow this UOA user to create private DeepWater research.' THEN
    RAISE EXCEPTION 'DEEPWATER_PRIVACY_FLAG_DESCRIPTION_DRIFT';
  END IF;

  UPDATE "feature_flag_definitions"
  SET
    "description" = 'Allows paid private DeepWater research for an entitled team.',
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "app_id" = target_app_id
    AND "key" = 'can_be_private';
END $$;
