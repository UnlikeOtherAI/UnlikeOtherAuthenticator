-- Phase A1 (SSO-owned team directory & invites): UOA becomes the only durable
-- authority for human identity, team membership, and invitations. A product
-- backend (first-party Nessie mapping) can read identity and manage/invite
-- members through scoped UOA APIs instead of creating local password users or
-- duplicate profiles. These are additive enum values on the existing
-- confidential-delegation allowlist; no existing mapping is touched and the
-- new scopes are never implied by ai.invoke.
ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'identity.read';
ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'membership.invite';
ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'membership.manage';

-- The 1..6 non-empty, NULL-free, duplicate-free scope bound is enforced by an
-- immutable helper so the predicate stays exact for every array length
-- (pairwise <> checks explode combinatorially at six values).
CREATE OR REPLACE FUNCTION public.confidential_delegation_scopes_unique(
  scopes "ConfidentialDelegationScope"[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT cardinality(scopes) BETWEEN 1 AND 6
    AND array_position(scopes, NULL) IS NULL
    AND cardinality(ARRAY(SELECT DISTINCT unnest(scopes))) = cardinality(scopes)
$$;

ALTER TABLE "confidential_delegation_mappings"
  DROP CONSTRAINT "confidential_delegation_mappings_scopes_check",
  ADD CONSTRAINT "confidential_delegation_mappings_scopes_check"
    CHECK (public.confidential_delegation_scopes_unique("scopes"));

-- The check runs with the table owner's rights; the function itself is
-- callable only by the privileged roles, matching the mapping table grants.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON FUNCTION public.confidential_delegation_scopes_unique(
      "ConfidentialDelegationScope"[]
    ) FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT EXECUTE ON FUNCTION public.confidential_delegation_scopes_unique(
      "ConfidentialDelegationScope"[]
    ) TO "uoa_admin";
  END IF;
END
$$;
