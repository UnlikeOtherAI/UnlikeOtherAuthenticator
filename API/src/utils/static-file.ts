import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from './errors.js';

export function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

export async function readStaticFileUnderRoot(params: {
  rootDir: string;
  relativePath: string;
}): Promise<{ body: Buffer; contentType: string }> {
  const rootDir = path.resolve(params.rootDir);
  const rel = params.relativePath.replace(/^\/+/, '');
  const normalized = path.normalize(rel);
  if (!normalized || normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const abs = path.resolve(rootDir, normalized);
  const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (!abs.startsWith(rootPrefix)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  let body: Buffer;
  try {
    body = await readFile(abs);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') throw new AppError('NOT_FOUND', 404);
    throw new AppError('INTERNAL', 500);
  }

  return { body, contentType: contentTypeForPath(abs) };
}
