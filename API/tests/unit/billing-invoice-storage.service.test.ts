import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Storage } from '@google-cloud/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FilesystemBillingInvoicePdfStorage,
  GcsBillingInvoicePdfStorage,
  validateBillingInvoiceStorageKey,
} from '../../src/services/billing-invoice-storage.service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('billing invoice PDF storage', () => {
  it('accepts only invoice-prefixed non-traversing keys', () => {
    for (const key of [
      '',
      '/billing-invoices/example.pdf',
      'other/example.pdf',
      'billing-invoices/../escape.pdf',
      'billing-invoices/a\\b.pdf',
    ]) {
      expect(() => validateBillingInvoiceStorageKey(key)).toThrow(
        'INVALID_BILLING_INVOICE_STORAGE_KEY',
      );
    }
    expect(validateBillingInvoiceStorageKey('billing-invoices/org_1/inv_1.pdf')).toBe(
      'billing-invoices/org_1/inv_1.pdf',
    );
  });

  it('writes a private immutable file and reads the same bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'uoa-invoices-'));
    roots.push(root);
    const storage = new FilesystemBillingInvoicePdfStorage(root);
    const key = 'billing-invoices/org_1/inv_1.pdf';
    const value = Buffer.from('%PDF-1.7\ninvoice\n%%EOF');

    await storage.putImmutable(key, value);

    await expect(storage.read(key)).resolves.toEqual(value);
    await expect(readFile(path.join(root, key))).resolves.toEqual(value);
    expect((await stat(path.join(root, key))).mode & 0o777).toBe(0o600);
    await expect(storage.putImmutable(key, value)).rejects.toThrow(
      'BILLING_INVOICE_PDF_ALREADY_EXISTS',
    );
  });

  it('uses GCS create-only semantics and private response metadata', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn().mockResolvedValue([Buffer.from('pdf')]);
    const file = vi.fn(() => ({ save, download }));
    const bucket = vi.fn(() => ({ file }));
    const storage = new GcsBillingInvoicePdfStorage('invoice-bucket', {
      bucket,
    } as unknown as Storage);

    await storage.putImmutable('billing-invoices/org_1/inv_1.pdf', Buffer.from('pdf'));

    expect(bucket).toHaveBeenCalledWith('invoice-bucket');
    expect(save).toHaveBeenCalledWith(
      Buffer.from('pdf'),
      expect.objectContaining({
        resumable: false,
        validation: 'crc32c',
        metadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' },
        preconditionOpts: { ifGenerationMatch: 0 },
      }),
    );
  });
});
