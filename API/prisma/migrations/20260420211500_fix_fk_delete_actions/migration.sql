ALTER TABLE "access_requests"
DROP CONSTRAINT "access_requests_user_id_fkey";

ALTER TABLE "access_requests"
ADD CONSTRAINT "access_requests_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "login_logs"
DROP CONSTRAINT "login_logs_user_id_fkey";

ALTER TABLE "login_logs"
ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "login_logs"
ADD CONSTRAINT "login_logs_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
