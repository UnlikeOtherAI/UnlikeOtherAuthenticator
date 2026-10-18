SET lock_timeout = '5s';
SET statement_timeout = '60s';
ALTER TABLE "native_oauth_flows" ADD COLUMN "authentication_evidence_id" TEXT;
