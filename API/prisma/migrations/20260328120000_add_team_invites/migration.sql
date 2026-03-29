-- Add durable team invites plus token linkage for invite acceptance.
CREATE TABLE "team_invites" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invite_name" VARCHAR(120),
    "team_role" TEXT NOT NULL DEFAULT 'member',
    "redirect_url" TEXT,
    "invited_by_user_id" TEXT,
    "invited_by_name" VARCHAR(120),
    "invited_by_email" TEXT,
    "accepted_user_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "verification_tokens"
ADD COLUMN "team_invite_id" TEXT;

CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "request_name" VARCHAR(120),
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_requested_at" TIMESTAMP(3) NOT NULL,
    "reviewed_at" TIMESTAMP(3),
    "review_reason" VARCHAR(500),
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT,
    "reviewed_by_user_id" TEXT,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "team_invites_org_id_idx" ON "team_invites"("org_id");
CREATE INDEX "team_invites_team_id_email_idx" ON "team_invites"("team_id", "email");
CREATE INDEX "team_invites_accepted_at_idx" ON "team_invites"("accepted_at");
CREATE INDEX "team_invites_revoked_at_idx" ON "team_invites"("revoked_at");
CREATE INDEX "verification_tokens_team_invite_id_idx" ON "verification_tokens"("team_invite_id");
CREATE INDEX "access_requests_org_id_team_id_status_idx" ON "access_requests"("org_id", "team_id", "status");
CREATE INDEX "access_requests_team_id_email_status_idx" ON "access_requests"("team_id", "email", "status");
CREATE INDEX "access_requests_user_id_idx" ON "access_requests"("user_id");

ALTER TABLE "team_invites"
ADD CONSTRAINT "team_invites_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organisations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_invites"
ADD CONSTRAINT "team_invites_team_id_fkey"
FOREIGN KEY ("team_id") REFERENCES "teams"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_invites"
ADD CONSTRAINT "team_invites_accepted_user_id_fkey"
FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "access_requests"
ADD CONSTRAINT "access_requests_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organisations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_requests"
ADD CONSTRAINT "access_requests_team_id_fkey"
FOREIGN KEY ("team_id") REFERENCES "teams"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_requests"
ADD CONSTRAINT "access_requests_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "access_requests"
ADD CONSTRAINT "access_requests_reviewed_by_user_id_fkey"
FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "verification_tokens"
ADD CONSTRAINT "verification_tokens_team_invite_id_fkey"
FOREIGN KEY ("team_invite_id") REFERENCES "team_invites"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
