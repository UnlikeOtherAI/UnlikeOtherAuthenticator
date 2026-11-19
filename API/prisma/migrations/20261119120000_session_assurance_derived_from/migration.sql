BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- An exact-target proof issued by the team-session grant names the original sign-in proof it was
-- derived from; validation walks to that original, so ending it ends every derived session.
ALTER TABLE "session_assurances" ADD COLUMN "derived_from_id" TEXT;
CREATE INDEX "session_assurances_derived_from_id_idx" ON "session_assurances"("derived_from_id");

COMMIT;
