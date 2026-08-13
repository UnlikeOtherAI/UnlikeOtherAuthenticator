-- Distinguish ordinary/policy family retirement from theft/corruption invalidation. A stale
-- predecessor can then increment the user credential epoch exactly once even when every family
-- row was already retired, without allowing repeated stale requests to keep incrementing it.
ALTER TABLE "refresh_tokens"
ADD COLUMN "security_revoked_at" TIMESTAMP(3);
