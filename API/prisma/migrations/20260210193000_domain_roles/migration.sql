-- Create per-domain role assignments.
--
-- Roles are per-domain (see Docs/brief.md 22.12): a single user can be SUPERUSER on one domain
-- and USER on another domain. We model this via a join table keyed by (domain, user_id).

-- CreateTable
CREATE TABLE "domain_roles" (
    "domain" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_roles_pkey" PRIMARY KEY ("domain","user_id")
);

-- AddForeignKey
ALTER TABLE "domain_roles" ADD CONSTRAINT "domain_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "domain_roles_user_id_idx" ON "domain_roles"("user_id");

-- Ensure only one SUPERUSER per domain (race condition resolved at DB constraint level).
CREATE UNIQUE INDEX "domain_roles_domain_superuser_key" ON "domain_roles"("domain") WHERE ("role" = 'SUPERUSER');

-- Backfill: if any existing users are already scoped to a domain, preserve their role assignment.
INSERT INTO "domain_roles" ("domain", "user_id", "role", "created_at")
SELECT "domain", "id", "role", "created_at"
FROM "users"
WHERE "domain" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Drop role from users; roles are stored per-domain in domain_roles.
ALTER TABLE "users" DROP COLUMN "role";
