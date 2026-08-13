-- Historical authorization codes and signing continuations cannot be assigned an issue-time
-- credential epoch after the fact. Leave them NULL so the application rejects them fail closed;
-- every newly issued row persists the exact locked users.token_version value.
ALTER TABLE "authorization_codes"
ADD COLUMN "token_version" INTEGER;

ALTER TABLE "signing_continuations"
ADD COLUMN "token_version" INTEGER;

ALTER TABLE "authorization_codes"
ADD CONSTRAINT "authorization_codes_token_version_check"
CHECK ("token_version" IS NULL OR "token_version" >= 0);

ALTER TABLE "signing_continuations"
ADD CONSTRAINT "signing_continuations_token_version_check"
CHECK ("token_version" IS NULL OR "token_version" >= 0);
