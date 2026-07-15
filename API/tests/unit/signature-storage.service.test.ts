import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Storage } from '@google-cloud/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FilesystemSignatureObjectStorage,
  GcsSignatureObjectStorage,
  validateSignatureStorageKey,
} from '../../src/services/signature-storage.service.js';

const roots: string[] = [];

async function tempStorage(): Promise<{ root: string; storage: FilesystemSignatureObjectStorage }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uoa-signatures-'));
  roots.push(root);
  return { root, storage: new FilesystemSignatureObjectStorage(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('signature object storage', () => {
  it('rejects traversal, absolute, empty, and backslash object keys', () => {
    for (const key of ['', '/absolute.pdf', '../escape.pdf', 'a/../escape.pdf', 'a\\b.pdf']) {
      expect(() => validateSignatureStorageKey(key)).toThrowError('INVALID_SIGNATURE_STORAGE_KEY');
    }
    expect(validateSignatureStorageKey('sources/example.com/agreement-1/v1.pdf')).toBe(
      'sources/example.com/agreement-1/v1.pdf',
    );
  });

  it('writes private immutable files and reads the same bytes', async () => {
    const { root, storage } = await tempStorage();
    const key = 'sources/example.com/agreement-1/v1.pdf';
    const value = Buffer.from('%PDF-1.7\nexample\n%%EOF');

    await storage.putImmutable(key, value, 'application/pdf');

    await expect(storage.read(key)).resolves.toEqual(value);
    await expect(readFile(path.join(root, key))).resolves.toEqual(value);
    expect((await stat(path.join(root, key))).mode & 0o777).toBe(0o600);
    await expect(storage.putImmutable(key, value, 'application/pdf')).rejects.toMatchObject({
      message: 'SIGNATURE_OBJECT_ALREADY_EXISTS',
      statusCode: 409,
    });
  });

  it('deletes drafts idempotently and maps missing reads to a generic not-found error', async () => {
    const { storage } = await tempStorage();
    const key = 'drafts/example.com/agreement-1/v1.pdf';
    await storage.putImmutable(key, Buffer.from('draft'), 'application/pdf');

    await storage.deleteDraft(key);
    await expect(storage.deleteDraft(key)).resolves.toBeUndefined();
    await expect(storage.read(key)).rejects.toMatchObject({
      message: 'SIGNATURE_OBJECT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('uses a GCS create-only generation precondition and private no-store metadata', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn().mockResolvedValue([Buffer.from('pdf')]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const file = vi.fn(() => ({ save, download, delete: remove }));
    const bucket = vi.fn(() => ({ file }));
    const storage = new GcsSignatureObjectStorage(
      'private-bucket',
      { bucket } as unknown as Storage,
    );

    await storage.putImmutable('receipts/example.com/sig-1.pdf', Buffer.from('pdf'), 'application/pdf');

    expect(bucket).toHaveBeenCalledWith('private-bucket');
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
