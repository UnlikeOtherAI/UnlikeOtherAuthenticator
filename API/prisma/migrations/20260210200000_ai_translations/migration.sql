-- CreateTable
CREATE TABLE "ai_translations" (
    "language" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_translations_pkey" PRIMARY KEY ("language")
);

-- CreateIndex
CREATE INDEX "ai_translations_source_hash_idx" ON "ai_translations"("source_hash");
