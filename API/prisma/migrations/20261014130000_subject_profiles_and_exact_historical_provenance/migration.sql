SET lock_timeout = '5s';
SET statement_timeout = '120s';
ALTER TABLE users ADD COLUMN pronouns_preset VARCHAR(32), ADD COLUMN pronouns_custom VARCHAR(120);
ALTER TABLE users ADD CONSTRAINT user_pronouns_shape CHECK ((
 (pronouns_preset IS NULL AND pronouns_custom IS NULL) OR
 (pronouns_preset IN ('he_him','she_her','they_them','any_pronouns','ask_me','prefer_not_to_say') AND pronouns_custom IS NULL) OR
 (pronouns_preset = 'custom' AND pronouns_custom IS NOT NULL AND length(btrim(pronouns_custom)) BETWEEN 1 AND 120)
) IS TRUE) NOT VALID;
CREATE TABLE historical_organisation_identity_references (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 org_id TEXT NOT NULL,
 PRIMARY KEY(user_id, org_id)
);
ALTER TABLE historical_organisation_identity_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_organisation_identity_references FORCE ROW LEVEL SECURITY;
CREATE POLICY historical_organisation_identity_references_deny ON historical_organisation_identity_references
 USING (false) WITH CHECK (false);
-- Historical domain-only evidence cannot establish an exact organisation. No backfill.
