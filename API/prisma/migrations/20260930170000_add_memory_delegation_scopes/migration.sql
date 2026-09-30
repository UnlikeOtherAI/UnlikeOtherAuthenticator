-- Scope vocabulary only: existing mapping grants are never expanded.
ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'memory.read';
ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'memory.write';

ALTER TABLE "confidential_delegation_mappings"
  DROP CONSTRAINT "confidential_delegation_mappings_scopes_check",
  ADD CONSTRAINT "confidential_delegation_mappings_scopes_check"
    CHECK (
      cardinality("scopes") BETWEEN 1 AND 5
      AND array_ndims("scopes") = 1
      AND array_lower("scopes", 1) = 1
      AND array_position("scopes", NULL) IS NULL
      AND (cardinality("scopes") < 2 OR "scopes"[1] <> "scopes"[2])
      AND (cardinality("scopes") < 3 OR "scopes"[1] <> "scopes"[3])
      AND (cardinality("scopes") < 3 OR "scopes"[2] <> "scopes"[3])
      AND (cardinality("scopes") < 4 OR "scopes"[1] <> "scopes"[4])
      AND (cardinality("scopes") < 4 OR "scopes"[2] <> "scopes"[4])
      AND (cardinality("scopes") < 4 OR "scopes"[3] <> "scopes"[4])
      AND (cardinality("scopes") < 5 OR "scopes"[1] <> "scopes"[5])
      AND (cardinality("scopes") < 5 OR "scopes"[2] <> "scopes"[5])
      AND (cardinality("scopes") < 5 OR "scopes"[3] <> "scopes"[5])
      AND (cardinality("scopes") < 5 OR "scopes"[4] <> "scopes"[5])
    );
