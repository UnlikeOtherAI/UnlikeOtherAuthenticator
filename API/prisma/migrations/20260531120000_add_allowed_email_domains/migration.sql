-- Allowed login email-domain restrictions at the client-domain, organisation, and team levels.
-- Empty array = no restriction. Enforced at login (any non-empty level the user is subject to
-- must include the user's email domain); SUPERUSER bypasses.
ALTER TABLE "client_domains" ADD COLUMN "allowed_email_domains" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "organisations" ADD COLUMN "allowed_email_domains" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "teams" ADD COLUMN "allowed_email_domains" TEXT[] NOT NULL DEFAULT '{}';
