ALTER TYPE "ConfidentialDelegationScope" ADD VALUE IF NOT EXISTS 'token.provision';

ALTER TABLE "confidential_delegation_mappings"
  DROP CONSTRAINT "confidential_delegation_mappings_scopes_check",
  ADD CONSTRAINT "confidential_delegation_mappings_scopes_check"
    CHECK (
      cardinality("scopes") BETWEEN 1 AND 3
      AND array_position("scopes", NULL) IS NULL
      AND (
        cardinality("scopes") < 2
        OR "scopes"[1] <> "scopes"[2]
      )
      AND (
        cardinality("scopes") < 3
        OR (
          "scopes"[1] <> "scopes"[3]
          AND "scopes"[2] <> "scopes"[3]
        )
      )
    );
