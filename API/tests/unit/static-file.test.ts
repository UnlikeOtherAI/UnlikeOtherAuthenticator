import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readStaticFileUnderRoot } from '../../src/utils/static-file.js';

let tempDir: string | null = null;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'uoa-static-'));
  return tempDir;
}

describe('readStaticFileUnderRoot', () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('reads files under the configured root with a content type', async () => {
    const rootDir = await makeTempDir();
    await writeFile(path.join(rootDir, 'index.html'), '<html></html>');

    const result = await readStaticFileUnderRoot({ rootDir, relativePath: 'index.html' });

    expect(result.body.toString('utf8')).toBe('<html></html>');
    expect(result.contentType).toBe('text/html; charset=utf-8');
  });

  it('rejects directory traversal outside the configured root', async () => {
    const rootDir = await makeTempDir();

    await expect(readStaticFileUnderRoot({ rootDir, relativePath: '../secret.txt' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
