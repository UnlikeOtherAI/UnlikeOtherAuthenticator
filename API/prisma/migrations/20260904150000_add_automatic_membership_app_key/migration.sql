-- A product-only service credential for automatic team membership. It is
-- deliberately distinct from billing and from the domain-hash backend bearer.
ALTER TYPE "BillingAppKeyPurpose" ADD VALUE IF NOT EXISTS 'AUTOMATIC_MEMBERSHIP';
