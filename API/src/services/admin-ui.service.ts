import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStaticFileUnderRoot } from '../utils/static-file.js';

function repoRootFrom(metaUrl: string): string {
  const here = path.dirname(fileURLToPath(metaUrl));
  return path.resolve(here, '../../../');
}

function adminDistDirFrom(metaUrl: string): string {
  return path.join(repoRootFrom(metaUrl), 'Admin', 'dist');
}

let cachedIndexHtml: string | null = null;

export async function readAdminIndexHtml(): Promise<string> {
  if (cachedIndexHtml) return cachedIndexHtml;
  const distDir = adminDistDirFrom(import.meta.url);
  cachedIndexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
  return cachedIndexHtml;
}

export function isAdminStaticAssetPath(relativePath: string): boolean {
  return Boolean(path.extname(relativePath));
}

export async function readAdminUiAsset(params: {
  relativePath: string;
}): Promise<{ body: Buffer; contentType: string }> {
  const distDir = adminDistDirFrom(import.meta.url);
  return readStaticFileUnderRoot({ rootDir: distDir, relativePath: params.relativePath });
}
