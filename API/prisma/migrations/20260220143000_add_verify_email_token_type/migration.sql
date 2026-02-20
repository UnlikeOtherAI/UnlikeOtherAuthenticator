-- Add passwordless registration token type.
-- NOTE: ALTER TYPE ... ADD VALUE is non-transactional on older PostgreSQL versions.
ALTER TYPE "VerificationTokenType" ADD VALUE IF NOT EXISTS 'VERIFY_EMAIL';
