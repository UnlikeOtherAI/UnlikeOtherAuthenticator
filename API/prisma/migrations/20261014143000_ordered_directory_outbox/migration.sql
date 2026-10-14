SET lock_timeout = '5s';
SET statement_timeout = '120s';
-- Deliberately no org FK: the cursor and terminal invalidation survive erasure.
CREATE TABLE directory_organisation_revisions (
 org_id TEXT PRIMARY KEY, revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE directory_change_outbox (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, revision BIGINT NOT NULL CHECK (revision > 0),
 kind VARCHAR(40) NOT NULL, subject_id TEXT, team_id TEXT,
 occurred_at TIMESTAMP(3) NOT NULL DEFAULT now(), UNIQUE(org_id, revision)
);
ALTER TABLE directory_organisation_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_organisation_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_organisation_revisions_deny ON directory_organisation_revisions USING(false) WITH CHECK(false);
ALTER TABLE directory_change_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_change_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_change_outbox_deny ON directory_change_outbox USING(false) WITH CHECK(false);
-- No events or fabricated revisions are backfilled from timestamps.
