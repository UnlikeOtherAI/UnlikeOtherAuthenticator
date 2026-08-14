
-- Abort fast behind live traffic (Docs/deploy.md): never queue behind a lock.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Phase A1 (SSO-owned team directory & invites): UOA becomes the only durable
-- authority for human identity, team membership, and invitations. A product
-- backend (the first-party `nessie-identity` mapping) can read identity and
-- manage/invite members through scoped UOA APIs instead of creating local
-- password users or duplicate profiles. These are additive enum values on the
-- existing confidential-delegation allowlist; no existing mapping is touched
-- and the new scopes are never implied by ai.invoke.
ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'identity.read';
ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'membership.invite';
ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'membership.manage';

-- The 1..6 non-empty, NULL-free, duplicate-free scope bound is enforced by an
-- immutable helper so the predicate stays exact for every array length
-- (pairwise <> checks explode combinatorially at six values). The function is
-- created in current_schema() — the isolated schema under test, `public` in
-- production — so the check and the grant block below can never pick up or
-- leave behind a same-named function in another schema.
CREATE OR REPLACE FUNCTION confidential_delegation_scopes_unique(
  scopes "ConfidentialDelegationScope"[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT cardinality(scopes) BETWEEN 1 AND 6
    AND array_position(scopes, NULL) IS NULL
    AND cardinality(ARRAY(SELECT DISTINCT unnest(scopes))) = cardinality(scopes)
$$;

ALTER TABLE "confidential_delegation_mappings"
  DROP CONSTRAINT "confidential_delegation_mappings_scopes_check",
  ADD CONSTRAINT "confidential_delegation_mappings_scopes_check"
    CHECK (confidential_delegation_scopes_unique("scopes"));

-- The check runs with the table owner's rights; the function itself is never
-- callable by PUBLIC or the runtime app role. Only the admin role keeps
-- EXECUTE, matching the mapping table grants.
DO $$
BEGIN
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.confidential_delegation_scopes_unique("ConfidentialDelegationScope"[]) FROM PUBLIC',
    current_schema()
  );
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.confidential_delegation_scopes_unique("ConfidentialDelegationScope"[]) FROM %I',
      current_schema(), 'uoa_app'
    );
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.confidential_delegation_scopes_unique("ConfidentialDelegationScope"[]) TO %I',
      current_schema(), 'uoa_admin'
    );
  END IF;
END
$$;
