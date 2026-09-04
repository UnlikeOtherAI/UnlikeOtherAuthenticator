-- Fence generations must also order lifecycle changes made within one generation.
ALTER TABLE "automatic_membership_provision_fences"
  ADD COLUMN "lifecycle_revision" integer NOT NULL DEFAULT 0;

ALTER TABLE "automatic_membership_subject_snapshots"
  ADD COLUMN "cursor_hash" text,
  ADD COLUMN "cursor_user_id" text;

ALTER TYPE "AutomaticMembershipOperationStatus" ADD VALUE IF NOT EXISTS 'skipped_inactive';
