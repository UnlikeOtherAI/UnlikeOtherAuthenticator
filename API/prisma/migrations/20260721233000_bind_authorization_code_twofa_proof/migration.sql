ALTER TABLE "authorization_codes"
ADD COLUMN "two_fa_completed" BOOLEAN NOT NULL DEFAULT false;
