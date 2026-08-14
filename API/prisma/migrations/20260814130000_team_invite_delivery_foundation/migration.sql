-- Abort fast behind live traffic (Docs/deploy.md): never queue behind a lock.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Phase A2.1a (SSO-owned team directory & invites) — database foundation.
--
-- Three parts:
--
--   1. team_invite_deliveries — the durable, non-secret email-delivery outbox
--      that a later checkpoint's dispatcher/scheduler will drain. One row per
--      (invite, generation); each resend bumps the invite's generation. The
--      payload is a non-secret JSON envelope (recipient email, display names,
--      accept URL template WITHOUT the token) — the table never stores a
--      plaintext or recoverable invite token.
--
--   2. team_invites hardening — duplicate actionable rows are revoked
--      deterministically (stable order), then a partial unique index makes
--      (team, lower(email)) unique for exactly one actionable invite; a
--      NOT VALID team-role check pins new writes to member/admin without
--      rewriting accepted historical owner rows; terminal-coherence checks
--      make accepted/declined/revoked mutually exclusive, pair accepted_at
--      with accepted_user_id, and forbid accepted rows that are still
--      PENDING or DENIED.
--
-- All DDL is current_schema()-portable (no hardcoded `public`) so the real
-- migration suite can apply it into an isolated test schema.

-- ---------------------------------------------------------------------------
-- 1a. Delivery status enum + outbox table.
-- ---------------------------------------------------------------------------
CREATE TYPE "TeamInviteDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT');

CREATE TABLE "team_invite_deliveries" (
  "id" TEXT NOT NULL,
  "invite_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "status" "TeamInviteDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" TIMESTAMP(3),
  "lease_expires_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_invite_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "team_invite_deliveries_generation_check" CHECK ("generation" >= 0),
  CONSTRAINT "team_invite_deliveries_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "team_invite_deliveries_last_error_code_check"
    CHECK ("last_error_code" IS NULL OR btrim("last_error_code") <> '')
);

CREATE UNIQUE INDEX "team_invite_deliveries_invite_id_generation_key"
  ON "team_invite_deliveries"("invite_id", "generation");
-- Dispatcher pickup: oldest deliverable PENDING row first.
CREATE INDEX "team_invite_deliveries_pending_idx"
  ON "team_invite_deliveries"("available_at")
  WHERE "status" = 'PENDING';
-- Reaper: stuck PROCESSING rows whose lease has expired.
CREATE INDEX "team_invite_deliveries_lease_idx"
  ON "team_invite_deliveries"("lease_expires_at")
  WHERE "status" = 'PROCESSING';

ALTER TABLE "team_invite_deliveries"
  ADD CONSTRAINT "team_invite_deliveries_invite_id_fkey"
  FOREIGN KEY ("invite_id") REFERENCES "team_invites"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 1b. RLS + grants. The outbox is written/claimed by the future dispatcher
--     through the BYPASSRLS admin client, so it is admin-only for now: deny
--     the runtime role and grant the admin role, guarded so dev/test without
--     the RLS roles keeps working. Policy is created with unqualified names
--     under the migration's search_path (current_schema()), exactly like
--     every prior policy migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    REVOKE ALL ON TABLE "team_invite_deliveries" FROM "uoa_app";
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "team_invite_deliveries" TO "uoa_admin";
  END IF;
END
$$;

ALTER TABLE "team_invite_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_invite_deliveries" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'uoa_app') THEN
    CREATE POLICY team_invite_deliveries_deny_app ON "team_invite_deliveries"
      FOR ALL TO uoa_app
      USING (false) WITH CHECK (false);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2a. Deterministically revoke duplicate actionable invites. "Actionable" is
--     exactly the partial-unique predicate below: not accepted, not declined,
--     not revoked, and approval_status not DENIED. Keep the earliest-created
--     row (ties broken by id) — the oldest pending invite is the one the
--     email-lookup and firstLogin pending-invites surfaces already show —
--     and revoke the rest with an audit-visible marker in no dedicated column
--     (revoked_at alone is the terminal signal; the loss of the duplicate is
--     by definition noise).
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "team_id", lower("email")
           ORDER BY "created_at" ASC, "id" ASC
         ) AS rn
  FROM "team_invites"
  WHERE "accepted_at" IS NULL
    AND "declined_at" IS NULL
    AND "revoked_at" IS NULL
    AND "approval_status" <> 'DENIED'
)
UPDATE "team_invites" t
SET "revoked_at" = CURRENT_TIMESTAMP,
    "updated_at" = CURRENT_TIMESTAMP
FROM ranked
WHERE t."id" = ranked."id"
  AND ranked.rn > 1;

-- ---------------------------------------------------------------------------
-- 2b. One actionable invite per (team, lower(email)).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "team_invites_one_actionable_per_team_email"
  ON "team_invites"("team_id", lower("email"))
  WHERE "accepted_at" IS NULL
    AND "declined_at" IS NULL
    AND "revoked_at" IS NULL
    AND "approval_status" <> 'DENIED';

-- ---------------------------------------------------------------------------
-- 2c. Role rail. Only member/admin invites may be written from now on;
--     accepted historical owner rows are left untouched (NOT VALID) and
--     Postgres re-checks the constraint on any future UPDATE of those rows.
-- ---------------------------------------------------------------------------
ALTER TABLE "team_invites"
  ADD CONSTRAINT "team_invites_team_role_check"
    CHECK ("team_role" IN ('member', 'admin')) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2d. Terminal coherence.
-- ---------------------------------------------------------------------------
ALTER TABLE "team_invites"
  ADD CONSTRAINT "team_invites_terminal_mutually_exclusive_check"
    CHECK (num_nonnulls("accepted_at", "declined_at", "revoked_at") <= 1),
  ADD CONSTRAINT "team_invites_acceptance_pair_check"
    CHECK (
      ("accepted_at" IS NULL AND "accepted_user_id" IS NULL)
      OR ("accepted_at" IS NOT NULL AND "accepted_user_id" IS NOT NULL)
    ),
  ADD CONSTRAINT "team_invites_accepted_approval_check"
    CHECK (
      "accepted_at" IS NULL
      OR "approval_status" NOT IN ('PENDING', 'DENIED')
    );
