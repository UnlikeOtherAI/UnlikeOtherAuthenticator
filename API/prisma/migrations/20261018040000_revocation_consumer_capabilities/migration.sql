SET lock_timeout='5s';
SET statement_timeout='60s';
ALTER TABLE org_revocation_consumers ADD COLUMN capability_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_revocation_consumers ADD CONSTRAINT revocation_capability_version CHECK(capability_version IN(0,1));
