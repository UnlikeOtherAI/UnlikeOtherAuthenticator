ALTER TABLE "authorization_codes"
ADD COLUMN "code_challenge" TEXT,
ADD COLUMN "code_challenge_method" TEXT;
