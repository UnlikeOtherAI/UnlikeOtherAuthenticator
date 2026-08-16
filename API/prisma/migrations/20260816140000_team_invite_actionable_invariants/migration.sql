-- Abort fast behind live traffic (Docs/deploy.md): never queue behind a lock.
SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- Team-invite lifecycle invariants (design §4.7).
--
-- The application already treats "the invite for this (team, email)" as a single live row, but
-- nothing enforced it: two concurrent creates could both find no existing invite and both insert,
-- leaving two actionable invites for one address. These constraints make that structural, and give
-- the pure state machine in `API/src/services/team-invite-state-machine.ts` a database floor.
--
-- Ordering matters. Existing rows are normalised FIRST, so the index build below cannot fail on
-- data a live deployment plausibly holds, and no constraint is added while rows still violate it.
--
-- All DDL is current_schema()-portable (no hardcoded `public`) so the migration suite can apply it
-- into an isolated test schema.

-- ---------------------------------------------------------------------------
-- 1. Collapse duplicate actionable invites.
--
--    "Actionable" is exactly the partial-unique predicate below: not accepted, not declined, not
--    revoked, and approval not DENIED. Keep the earliest-created row (ties broken by id, so the
--    choice is deterministic and re-runnable) — the oldest pending invite is the one the email
--    lookup and the firstLogin pending-invites surface already show — and revoke the rest.
--
--    `REPLACED` is the honest reason: these rows were superseded by a newer invite to the same
--    address, which is precisely what the reason means (`20260815090000_team_invite_revocation`
--    backfilled every pre-existing revoked row the same way). Leaving `revoked_reason` NULL would
--    contradict that migration's invariant that a set `revoked_at` always carries a reason.
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
    "revoked_reason" = 'REPLACED',
    "updated_at" = CURRENT_TIMESTAMP
FROM ranked
WHERE t."id" = ranked."id"
  AND ranked.rn > 1;

-- ---------------------------------------------------------------------------
-- 2. Terminalise actionable `owner` invitations.
--
--    `owner` is the one fixed role in every domain's vocabulary and implicitly holds every
--    capability at its scope (API/src/services/role-grants.ts), so an emailed invitation granting
--    it would hand full authority over a team to whoever controls a mailbox. Ownership comes from
--    direct membership management, never from an invite — the rail added in step 4.
--
--    `REVOKED` rather than `REPLACED`: nothing superseded these, they are being cancelled.
--    Accepted historical owner invites are deliberately untouched; their acceptance is a fact, and
--    the NOT VALID constraint in step 4 leaves them alone.
-- ---------------------------------------------------------------------------
UPDATE "team_invites"
SET "revoked_at" = CURRENT_TIMESTAMP,
    "revoked_reason" = 'REVOKED',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "team_role" = 'owner'
  AND "accepted_at" IS NULL
  AND "declined_at" IS NULL
  AND "revoked_at" IS NULL
  AND "approval_status" <> 'DENIED';

-- ---------------------------------------------------------------------------
-- 3. One actionable invite per (team, lower(email)).
--
--    Safe to build as a validating index because steps 1 and 2 just guaranteed the predicate holds.
--    `lower(email)` matches the application, which normalises every address to lower case before
--    reading or writing, so a stored mixed-case legacy row still collides with its own duplicate.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "team_invites_one_actionable_per_team_email"
  ON "team_invites"("team_id", lower("email"))
  WHERE "accepted_at" IS NULL
    AND "declined_at" IS NULL
    AND "revoked_at" IS NULL
    AND "approval_status" <> 'DENIED';

-- ---------------------------------------------------------------------------
-- 4. Role rail: no invitation may grant `owner`.
--
--    Deliberately `<> 'owner'` and NOT an `IN ('member','admin')` list. The team-role vocabulary is
--    per-domain configuration (`org_features.team_roles`, resolved by
--    API/src/services/role-grants.ts) and the database cannot see it, so an enumerated list here
--    would silently refuse every role a domain invented. `owner` is the one role guaranteed to
--    exist in every vocabulary and the one role that must never be invitable, which makes it the
--    only part of the rule the database can honestly hold. The per-domain half is enforced in
--    `normalizeInviteGrantRole`.
--
--    NOT VALID: accepted historical owner rows are never rewritten by the deploy. Postgres still
--    re-checks the constraint on any future UPDATE of such a row, and step 2 already removed every
--    actionable one, so no live path can meet it.
-- ---------------------------------------------------------------------------
ALTER TABLE "team_invites"
  ADD CONSTRAINT "team_invites_team_role_check"
    CHECK ("team_role" <> 'owner') NOT VALID;

-- ---------------------------------------------------------------------------
-- 5. Terminal coherence.
--
--    Accepted / declined / revoked are mutually exclusive; acceptance pairs its timestamp with the
--    user who accepted; an accepted invite can never still be awaiting or refused approval.
--
--    All three are NOT VALID for the same reason as step 4: they describe how rows must be written
--    from now on, and a deploy must not fail on — or silently rewrite — historical rows whose
--    provenance nobody can reconstruct. Every write path is already consistent with them, and any
--    future UPDATE of a legacy row is re-checked.
-- ---------------------------------------------------------------------------
ALTER TABLE "team_invites"
  ADD CONSTRAINT "team_invites_terminal_mutually_exclusive_check"
    CHECK (num_nonnulls("accepted_at", "declined_at", "revoked_at") <= 1) NOT VALID,
  ADD CONSTRAINT "team_invites_acceptance_pair_check"
    CHECK (
      ("accepted_at" IS NULL AND "accepted_user_id" IS NULL)
      OR ("accepted_at" IS NOT NULL AND "accepted_user_id" IS NOT NULL)
    ) NOT VALID,
  ADD CONSTRAINT "team_invites_accepted_approval_check"
    CHECK (
      "accepted_at" IS NULL
      OR "approval_status" NOT IN ('PENDING', 'DENIED')
    ) NOT VALID;
