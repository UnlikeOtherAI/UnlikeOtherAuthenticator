-- Refresh-token hashes now use HMAC-SHA256 with SHARED_SECRET as the pepper.
-- Existing rows from the previous hash scheme cannot be redeemed safely, so force
-- re-authentication once on deploy instead of leaving silently invalid sessions.
DELETE FROM "refresh_tokens";
