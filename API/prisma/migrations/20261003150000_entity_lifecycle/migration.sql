SET lock_timeout = '5s';
SET statement_timeout = '120s';
-- CreateEnum
CREATE TYPE "EntityLifecycleStatus" AS ENUM ('ACTIVE', 'DISABLED', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "LifecycleScope" AS ENUM ('USER', 'ORGANISATION', 'TEAM');

-- CreateEnum
CREATE TYPE "IdentityDeletionMode" AS ENUM ('RETAIN_REFERENCE', 'ERASE_REFERENCE');

-- CreateEnum
CREATE TYPE "DeletionJobStatus" AS ENUM ('WAITING_FOR_PRODUCTS', 'READY', 'BLOCKED', 'COMPLETE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lifecycle_changed_at" TIMESTAMP(3),
ADD COLUMN     "lifecycle_internal_note" VARCHAR(2000),
ADD COLUMN     "lifecycle_reason" VARCHAR(2000),
ADD COLUMN     "lifecycle_status" "EntityLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "lifecycle_template_id" TEXT,
ADD COLUMN     "lifecycle_template_revision" INTEGER,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "user_key" DROP NOT NULL;

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "lifecycle_changed_at" TIMESTAMP(3),
ADD COLUMN     "lifecycle_internal_note" VARCHAR(2000),
ADD COLUMN     "lifecycle_reason" VARCHAR(2000),
ADD COLUMN     "lifecycle_status" "EntityLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "lifecycle_template_id" TEXT,
ADD COLUMN     "lifecycle_template_revision" INTEGER;

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "lifecycle_changed_at" TIMESTAMP(3),
ADD COLUMN     "lifecycle_internal_note" VARCHAR(2000),
ADD COLUMN     "lifecycle_reason" VARCHAR(2000),
ADD COLUMN     "lifecycle_status" "EntityLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "lifecycle_template_id" TEXT,
ADD COLUMN     "lifecycle_template_revision" INTEGER;

-- CreateTable
CREATE TABLE "lifecycle_reason_templates" (
    "id" TEXT NOT NULL,
    "scope" "LifecycleScope" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifecycle_reason_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_deletion_jobs" (
    "id" TEXT NOT NULL,
    "scope" "LifecycleScope" NOT NULL,
    "target_id" TEXT NOT NULL,
    "mode" "IdentityDeletionMode" NOT NULL,
    "status" "DeletionJobStatus" NOT NULL,
    "request_key" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "preview" JSONB NOT NULL,
    "blockers" JSONB NOT NULL DEFAULT '[]',
    "actor_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "entity_deletion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_deletion_participants" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "client_domain_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "acknowledged_at" TIMESTAMP(3),
    "outcome" VARCHAR(2000),

    CONSTRAINT "entity_deletion_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "entity_deletion_jobs_request_key_key" ON "entity_deletion_jobs"("request_key");

-- CreateIndex
CREATE UNIQUE INDEX "entity_deletion_jobs_scope_target_id_key" ON "entity_deletion_jobs"("scope", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_deletion_participants_job_id_client_domain_id_key" ON "entity_deletion_participants"("job_id", "client_domain_id");

-- AddForeignKey
ALTER TABLE "entity_deletion_participants" ADD CONSTRAINT "entity_deletion_participants_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "entity_deletion_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE organisations ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE organisations ADD CONSTRAINT organisations_live_owner CHECK (lifecycle_status IN ('DELETING','DELETED') OR owner_id IS NOT NULL);
ALTER TABLE users ADD CONSTRAINT users_identity_lifecycle CHECK (
  (lifecycle_status = 'DELETED' AND email IS NULL AND user_key IS NULL AND name IS NULL
   AND password_hash IS NULL AND "2fa_secret" IS NULL AND "2fa_enabled" = false AND avatar_url IS NULL)
  OR (lifecycle_status <> 'DELETED' AND email IS NOT NULL AND user_key IS NOT NULL)
);

ALTER TABLE lifecycle_reason_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_reason_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE entity_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_deletion_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE entity_deletion_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_deletion_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY lifecycle_reason_templates_deny ON lifecycle_reason_templates USING (false) WITH CHECK (false);
CREATE POLICY entity_deletion_jobs_deny ON entity_deletion_jobs USING (false) WITH CHECK (false);
CREATE POLICY entity_deletion_participants_deny ON entity_deletion_participants USING (false) WITH CHECK (false);

CREATE FUNCTION uoa_lifecycle_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  data jsonb := to_jsonb(NEW);
  uid text := COALESCE(data->>'user_id',data->>'owner_id',data->>'requested_by_user_id',data->>'invited_by_user_id',data->>'created_by_user_id');
  oid text := COALESCE(data->>'org_id',data->>'organisation_id');
  tid text := data->>'team_id';
BEGIN
  -- Removing a membership is allowed while its container is being deleted.
  IF TG_TABLE_NAME IN ('org_members','team_members') AND data->>'status' <> 'ACTIVE' THEN RETURN NEW; END IF;
  IF uid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = uid AND lifecycle_status = 'ACTIVE' FOR SHARE) THEN
    RAISE EXCEPTION 'Identity unavailable' USING ERRCODE = '23514';
  END IF;
  IF oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organisations WHERE id = oid AND lifecycle_status = 'ACTIVE' FOR SHARE) THEN
    RAISE EXCEPTION 'Organisation unavailable' USING ERRCODE = '23514';
  END IF;
  IF tid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t JOIN organisations o ON o.id=t.org_id
      WHERE t.id=tid AND t.lifecycle_status='ACTIVE' AND o.lifecycle_status='ACTIVE' FOR SHARE OF t,o) THEN
    RAISE EXCEPTION 'Team unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lifecycle_organisations BEFORE INSERT ON organisations FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_teams BEFORE INSERT ON teams FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_auth_codes BEFORE INSERT ON authorization_codes FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_refresh_tokens BEFORE INSERT ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_org_members BEFORE INSERT OR UPDATE ON org_members FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_team_members BEFORE INSERT OR UPDATE ON team_members FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_domain_roles BEFORE INSERT OR UPDATE ON domain_roles FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_invites BEFORE INSERT ON team_invites FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_invite_links BEFORE INSERT ON team_invite_links FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_access_requests BEFORE INSERT ON access_requests FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();
CREATE TRIGGER lifecycle_billing_actions AFTER INSERT ON billing_customer_action_intents FOR EACH ROW EXECUTE FUNCTION uoa_lifecycle_reference_guard();

CREATE FUNCTION uoa_terminal_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.lifecycle_status='DELETED' OR (OLD.lifecycle_status='DELETING' AND NEW.lifecycle_status NOT IN ('DELETING','DELETED')) THEN
    RAISE EXCEPTION 'Terminal lifecycle cannot be changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_terminal_lifecycle BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION uoa_terminal_lifecycle_guard();
CREATE TRIGGER organisations_terminal_lifecycle BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION uoa_terminal_lifecycle_guard();
CREATE TRIGGER teams_terminal_lifecycle BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION uoa_terminal_lifecycle_guard();
ALTER TYPE "VerificationTokenType" ADD VALUE 'LIFECYCLE_STATUS';
CREATE TABLE historical_identity_references (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  PRIMARY KEY(user_id,domain)
);
ALTER TABLE historical_identity_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_identity_references FORCE ROW LEVEL SECURITY;
CREATE POLICY historical_identity_references_deny ON historical_identity_references USING (false) WITH CHECK (false);
