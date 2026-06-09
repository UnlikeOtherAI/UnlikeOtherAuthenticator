ALTER TABLE "client_domains" ADD COLUMN "allowed_emails" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "organisations"  ADD COLUMN "allowed_emails" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "teams"          ADD COLUMN "allowed_emails" TEXT[] NOT NULL DEFAULT '{}';
