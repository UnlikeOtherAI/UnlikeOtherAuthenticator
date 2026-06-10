CREATE TYPE "TwoFaPolicy" AS ENUM ('OFF', 'OPTIONAL', 'REQUIRED');

ALTER TABLE "client_domains"
  ADD COLUMN "two_fa_policy" "TwoFaPolicy" NOT NULL DEFAULT 'OPTIONAL';

ALTER TABLE "organisations"
  ADD COLUMN "two_fa_policy" "TwoFaPolicy";
