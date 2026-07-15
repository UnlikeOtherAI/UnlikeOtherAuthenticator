import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260715220000_harden_domain_signature_evidence/migration.sql',
  import.meta.url,
);

describe('signature evidence hardening migration', () => {
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
    expect(sql).toContain("OLD.\"status\" = 'PUBLISHED'");
    expect(sql).toContain("NEW.\"status\" IN ('SUPERSEDED', 'WITHDRAWN')");
    expect(sql).toContain('agreement_signatures_append_only');
    expect(sql).toContain('signature_revocations_append_only');
    expect(sql).toContain('signature_audit_events_append_only');
  });
});
