-- CreateTable
CREATE TABLE "authorization_codes" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "config_url" TEXT NOT NULL,
    "redirect_url" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "authorization_codes_code_hash_key" ON "authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "authorization_codes_user_id_idx" ON "authorization_codes"("user_id");

-- CreateIndex
CREATE INDEX "authorization_codes_domain_idx" ON "authorization_codes"("domain");

-- CreateIndex
CREATE INDEX "authorization_codes_expires_at_idx" ON "authorization_codes"("expires_at");

-- CreateIndex
CREATE INDEX "authorization_codes_created_at_idx" ON "authorization_codes"("created_at");

-- AddForeignKey
ALTER TABLE "authorization_codes" ADD CONSTRAINT "authorization_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

