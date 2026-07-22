import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const foundationMigrationUrl = new URL(
  '../../prisma/migrations/20260715120000_add_domain_signatures_foundation/migration.sql',
  import.meta.url,
);
const migrationUrl = new URL(
  '../../prisma/migrations/20260715220000_harden_domain_signature_evidence/migration.sql',
  import.meta.url,
);
const continuationMigrationUrl = new URL(
  '../../prisma/migrations/20260715230000_complete_signing_continuation_state/migration.sql',
  import.meta.url,
);
const retentionMigrationUrl = new URL(
  '../../prisma/migrations/20260715231000_bound_signature_retention_days/migration.sql',
  import.meta.url,
);
const claimIntentMigrationUrl = new URL(
  '../../prisma/migrations/20260722153000_add_signature_claim_intents/migration.sql',
  import.meta.url,
);

describe('signature evidence hardening migration', () => {
  it('blocks user, domain, version, continuation, and signature deletion while evidence is retained', async () => {
    const sql = await readFile(foundationMigrationUrl, 'utf8');
    for (const foreignKey of [
      'agreement_signatures_user_id_fkey',
      'agreement_signatures_domain_fkey',
      'agreement_signatures_agreement_version_id_fkey',
      'agreement_signatures_signing_continuation_id_fkey',
      'signature_revocations_signature_id_fkey',
    ]) {
      expect(sql).toContain(foreignKey);
    }
    expect(sql.match(/ON DELETE RESTRICT/gu)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  it('enforces one published version, idempotent continuation evidence, and unique object keys', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('agreement_versions_one_published_per_agreement');
    expect(sql).toContain('WHERE "status" = \'PUBLISHED\'');
    expect(sql).toContain('agreement_signatures_continuation_version_key');
    expect(sql).toContain('agreement_versions_source_storage_key_key');
    expect(sql).toContain('agreement_signatures_receipt_storage_key_key');
  });

  it('makes published versions, signatures, revocations, and signature audit events immutable', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('agreement_versions_immutable');
    expect(sql).toContain('OLD."status" = \'PUBLISHED\'');
    expect(sql).toContain("NEW.\"status\" IN ('SUPERSEDED', 'WITHDRAWN')");
    expect(sql).toContain('agreement_signatures_append_only');
    expect(sql).toContain('signature_revocations_append_only');
    expect(sql).toContain('signature_audit_events_append_only');
  });
});

describe('signing continuation state migration', () => {
  it('preserves exact public/config flow state and bounds invalid continuation rows', async () => {
    const sql = await readFile(continuationMigrationUrl, 'utf8');
    expect(sql).toContain('"oauth_scope" VARCHAR(512)');
    expect(sql).toContain('ALTER TABLE "authorization_codes"');
    expect(sql).toContain('"request_access" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('signing_continuations_attempt_count_check');
    expect(sql).toContain('signing_continuations_expiry_check');
    expect(sql).toContain('signing_continuations_profile_state_check');
  });
});

describe('signature retention migration', () => {
  it('enforces the documented explicit retention range in PostgreSQL', async () => {
    const sql = await readFile(retentionMigrationUrl, 'utf8');
    expect(sql).toContain('"retention_days" BETWEEN 1 AND 36500');
  });
});

describe('durable signature claim intent migration', () => {
  it('enforces one claim per continuation/version and one signature per claim', async () => {
    const sql = await readFile(claimIntentMigrationUrl, 'utf8');
    expect(sql).toContain('signature_claim_intents_continuation_version_key');
    expect(sql).toContain('agreement_signatures_claim_intent_id_key');
    expect(sql).toContain('agreement_signatures_claim_intent_id_fkey');
    expect(sql).toContain('ON DELETE RESTRICT');
  });

  it('permits only claimed, evidence-ready, completed, or invalidated durable states', async () => {
    const sql = await readFile(claimIntentMigrationUrl, 'utf8');
    expect(sql).toContain('"SignatureClaimIntentStatus"');
    expect(sql).toContain('signature_claim_intents_state_check');
    expect(sql).toContain('OLD."status" = \'CLAIMED\'');
    expect(sql).toContain("NEW.\"status\" NOT IN ('EVIDENCE_READY', 'INVALIDATED')");
    expect(sql).toContain('OLD."status" = \'EVIDENCE_READY\'');
    expect(sql).toContain("NEW.\"status\" NOT IN ('COMPLETED', 'INVALIDATED')");
    expect(sql).toContain('"evidence_manifest_sha256" IS NOT NULL');
    expect(sql).toContain('"receipt_pdf_sha256" IS NOT NULL');
  });

  it('makes exact claim inputs and terminal evidence append-only and denies uoa_app', async () => {
    const sql = await readFile(claimIntentMigrationUrl, 'utf8');
    expect(sql).toContain('signature claim inputs are immutable');
    expect(sql).toContain('terminal signature claim intents are immutable');
    expect(sql).toContain('signature claim evidence is immutable');
    expect(sql).toContain('signature_claim_intents_state_machine');
    expect(sql).toContain('signature_claim_intents_deny_app');
    expect(sql).toContain('REVOKE ALL ON TABLE "signature_claim_intents" FROM "uoa_app"');
  });
});
