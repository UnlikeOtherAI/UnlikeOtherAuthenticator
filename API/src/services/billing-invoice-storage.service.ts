import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Storage } from '@google-cloud/storage';

import { getEnv, type Env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export interface BillingInvoicePdfStorage {
  putImmutable(key: string, value: Uint8Array): Promise<void>;
  read(key: string): Promise<Buffer>;
}

export function validateBillingInvoiceStorageKey(key: string): string {
  if (
    key.length < 1 ||
    key.length > 1024 ||
    !key.startsWith('billing-invoices/') ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\\') ||
    !/^[a-zA-Z0-9._/-]+$/.test(key)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_INVOICE_STORAGE_KEY');
  }
  const parts = key.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_INVOICE_STORAGE_KEY');
  }
  return key;
}

function isAlreadyExists(error: unknown): boolean {
  const value = error as { code?: unknown } | null;
  return value?.code === 'EEXIST' || value?.code === 409 || value?.code === 412;
}

export class FilesystemBillingInvoicePdfStorage implements BillingInvoicePdfStorage {
  private readonly root: string;

  public constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const resolved = path.resolve(this.root, validateBillingInvoiceStorageKey(key));
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_BILLING_INVOICE_STORAGE_KEY');
    }
    return resolved;
  }

  public async putImmutable(key: string, value: Uint8Array): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await writeFile(target, value, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_PDF_ALREADY_EXISTS');
      }
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_PDF_WRITE_FAILED');
    }
  }

  public async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
        throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_PDF_NOT_FOUND');
      }
      if (error instanceof AppError) throw error;
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_PDF_READ_FAILED');
    }
  }
}

export class GcsBillingInvoicePdfStorage implements BillingInvoicePdfStorage {
  public constructor(
    private readonly bucketName: string,
    private readonly storage: Storage,
  ) {}

  public async putImmutable(key: string, value: Uint8Array): Promise<void> {
    const file = this.storage.bucket(this.bucketName).file(validateBillingInvoiceStorageKey(key));
    try {
      await file.save(Buffer.from(value), {
        resumable: false,
        validation: 'crc32c',
        metadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_PDF_ALREADY_EXISTS');
      }
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_PDF_WRITE_FAILED');
    }
  }

  public async read(key: string): Promise<Buffer> {
    try {
      const [value] = await this.storage
        .bucket(this.bucketName)
        .file(validateBillingInvoiceStorageKey(key))
        .download();
      return value;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 404) {
        throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_PDF_NOT_FOUND');
      }
      if (error instanceof AppError) throw error;
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_PDF_READ_FAILED');
    }
  }
}

export function createBillingInvoicePdfStorage(env: Env = getEnv()): BillingInvoicePdfStorage {
  if (
    env.BILLING_INVOICE_STORAGE_PROVIDER === 'filesystem' &&
    env.BILLING_INVOICE_FILESYSTEM_ROOT
  ) {
    return new FilesystemBillingInvoicePdfStorage(env.BILLING_INVOICE_FILESYSTEM_ROOT);
  }
  if (env.BILLING_INVOICE_STORAGE_PROVIDER === 'gcs' && env.BILLING_INVOICE_GCS_BUCKET) {
    return new GcsBillingInvoicePdfStorage(
      env.BILLING_INVOICE_GCS_BUCKET,
      new Storage({ projectId: env.BILLING_INVOICE_GCS_PROJECT_ID }),
    );
  }
  throw new AppError('INTERNAL', 503, 'BILLING_INVOICE_PDF_STORAGE_DISABLED');
}
