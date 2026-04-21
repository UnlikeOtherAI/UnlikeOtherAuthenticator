CREATE TABLE "handshake_error_logs" (
    "id" TEXT NOT NULL,
    "app" TEXT,
    "app_id" TEXT,
    "domain" TEXT NOT NULL,
    "organisation" TEXT,
    "endpoint" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "error_code" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "missing_claims" JSONB NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT NOT NULL,
    "jwt_header" JSONB NOT NULL,
    "jwt_payload" JSONB NOT NULL,
    "redactions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handshake_error_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "handshake_error_logs_request_id_idx" ON "handshake_error_logs"("request_id");

CREATE INDEX "handshake_error_logs_created_at_idx" ON "handshake_error_logs"("created_at");

CREATE INDEX "handshake_error_logs_domain_created_at_idx" ON "handshake_error_logs"("domain", "created_at");

CREATE INDEX "handshake_error_logs_phase_created_at_idx" ON "handshake_error_logs"("phase", "created_at");

CREATE INDEX "handshake_error_logs_error_code_created_at_idx" ON "handshake_error_logs"("error_code", "created_at");
