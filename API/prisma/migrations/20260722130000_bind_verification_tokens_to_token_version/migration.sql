-- Existing user-bound capabilities predate issue-time credential epochs and
-- cannot be safely reconstructed: the user's current epoch may already have
-- advanced since issuance. Leave them NULL so consumers fail closed. New
-- issuers persist the exact User.token_version snapshot.
ALTER TABLE "verification_tokens"
ADD COLUMN "token_version" INTEGER;
