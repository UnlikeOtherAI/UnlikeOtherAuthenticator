SET lock_timeout='5s';
SET statement_timeout='60s';
ALTER TABLE organisation_email_domains ADD COLUMN last_verified_at TIMESTAMP(3);
UPDATE organisation_email_domains SET last_verified_at=coalesce(checked_at,verified_at) WHERE status='VERIFIED';
