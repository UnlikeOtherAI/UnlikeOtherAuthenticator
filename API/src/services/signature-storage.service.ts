import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Storage } from '@google-cloud/storage';

import { getEnv, type Env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export interface SignatureObjectStorage {
  putImmutable(key: string, value: Uint8Array, contentType: 'application/pdf'): Promise<void>;
  read(key: string): Promise<Buffer>;
  deleteDraft(key: string): Promise<void>;
}

export function validateSignatureStorageKey(key: string): string {
  if (
    key.length < 1 ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\\') ||
    !/^[a-zA-Z0-9._/-]+$/.test(key)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_STORAGE_KEY');
  }
  const parts = key.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_STORAGE_KEY');
  }
  return key;
}

function isAlreadyExists(err: unknown): boolean {
  const value = err as { code?: unknown } | null;
  return value?.code === 'EEXIST' || value?.code === 409 || value?.code === 412;
}

export class FilesystemSignatureObjectStorage implements SignatureObjectStorage {
  private readonly root: string;

  public constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const normalized = validateSignatureStorageKey(key);
    const resolved = path.resolve(this.root, normalized);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new AppError('BAD_REQUEST', 400, 'INVALID_SIGNATURE_STORAGE_KEY');
    }
    return resolved;
  }

  public async putImmutable(
    key: string,
    value: Uint8Array,
    _contentType: 'application/pdf',
  ): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await writeFile(target, value, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (isAlreadyExists(err)) {
        throw new AppError('BAD_REQUEST', 409, 'SIGNATURE_OBJECT_ALREADY_EXISTS');
      }
      throw new AppError('INTERNAL', 500, 'SIGNATURE_STORAGE_WRITE_FAILED');
    }
  }

  public async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') {
        throw new AppError('NOT_FOUND', 404, 'SIGNATURE_OBJECT_NOT_FOUND');
      }
      if (err instanceof AppError) throw err;
      throw new AppError('INTERNAL', 500, 'SIGNATURE_STORAGE_READ_FAILED');
    }
  }

  public async deleteDraft(key: string): Promise<void> {
    try {
      await rm(this.resolve(key));
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ENOENT') return;
      if (err instanceof AppError) throw err;
      throw new AppError('INTERNAL', 500, 'SIGNATURE_STORAGE_DELETE_FAILED');
    }
  }

  public async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key), fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export class GcsSignatureObjectStorage implements SignatureObjectStorage {
  public constructor(
    private readonly bucketName: string,
    private readonly storage: Storage,
  ) {}

  public async putImmutable(
    key: string,
    value: Uint8Array,
    contentType: 'application/pdf',
  ): Promise<void> {
    const file = this.storage.bucket(this.bucketName).file(validateSignatureStorageKey(key));
    try {
      await file.save(Buffer.from(value), {
        resumable: false,
        validation: 'crc32c',
        metadata: { contentType, cacheControl: 'private, no-store' },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (err) {
      if (isAlreadyExists(err)) {
        throw new AppError('BAD_REQUEST', 409, 'SIGNATURE_OBJECT_ALREADY_EXISTS');
      }
      throw new AppError('INTERNAL', 500, 'SIGNATURE_STORAGE_WRITE_FAILED');
    }
  }

  public async read(key: string): Promise<Buffer> {
    try {
      const [value] = await this.storage
        .bucket(this.bucketName)
        .file(validateSignatureStorageKey(key))
        .download();
      return value;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 404) {
        throw new AppError('NOT_FOUND', 404, 'SIGNATURE_OBJECT_NOT_FOUND');
      }
      if (err instanceof AppError) throw err;
      throw new AppError('INTERNAL', 500, 'SIGNATURE_STORAGE_READ_FAILED');
    }
  }

  public async deleteDraft(key: string): Promise<void> {
    try {
      await this.storage
        .bucket(this.bucketName)
        .file(validateSignatureStorageKey(key))
        .delete({ ignoreNotFound: true });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('INTERNAL', 500, 'SIGNATURE_STORAGE_DELETE_FAILED');
    }
  }
}

export function createSignatureObjectStorage(env: Env = getEnv()): SignatureObjectStorage {
  if (env.SIGNATURE_STORAGE_PROVIDER === 'filesystem' && env.SIGNATURE_FILESYSTEM_ROOT) {
    return new FilesystemSignatureObjectStorage(env.SIGNATURE_FILESYSTEM_ROOT);
  }
  if (env.SIGNATURE_STORAGE_PROVIDER === 'gcs' && env.SIGNATURE_GCS_BUCKET) {
    return new GcsSignatureObjectStorage(
      env.SIGNATURE_GCS_BUCKET,
      new Storage({ projectId: env.SIGNATURE_GCS_PROJECT_ID }),
    );
  }
  throw new AppError('INTERNAL', 500, 'SIGNATURE_STORAGE_DISABLED');
}
