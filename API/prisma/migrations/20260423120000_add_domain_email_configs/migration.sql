CREATE TABLE "domain_email_configs" (
    "domain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mailing_domain" TEXT,
    "from_address" TEXT,
    "from_name" TEXT,
    "reply_to_default" TEXT,
    "ses_region" TEXT NOT NULL DEFAULT 'eu-west-1',
    "ses_verification" TEXT,
    "ses_dkim" TEXT,
    "dkim_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_email_configs_pkey" PRIMARY KEY ("domain")
);

ALTER TABLE "domain_email_configs"
ADD CONSTRAINT "domain_email_configs_domain_fkey"
FOREIGN KEY ("domain") REFERENCES "client_domains"("domain")
ON DELETE CASCADE ON UPDATE CASCADE;
