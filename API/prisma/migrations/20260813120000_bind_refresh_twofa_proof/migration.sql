ALTER TABLE "refresh_tokens"
ADD COLUMN "two_fa_completed" BOOLEAN NOT NULL DEFAULT false;
