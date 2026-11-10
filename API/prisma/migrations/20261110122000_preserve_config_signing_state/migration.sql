-- Config-JWT continuations retain the original opaque relying-party state,
-- including the exact machine request id. Do not erase it to fit the old check.
-- Keep confidential/public profile separation and machine intent confinement.
ALTER TABLE signing_continuations
  DROP CONSTRAINT signing_continuations_profile_state_check,
  ADD CONSTRAINT signing_continuations_profile_state_check CHECK (
    (auth_profile = 'CONFIG_JWT'
      AND config_url IS NOT NULL
      AND oauth_client_id IS NULL
      AND resource IS NULL
      AND oauth_scope IS NULL)
    OR
    (auth_profile = 'PUBLIC_OAUTH'
      AND config_url IS NULL
      AND oauth_client_id IS NOT NULL
      AND machine_intent_id IS NULL)
  );
