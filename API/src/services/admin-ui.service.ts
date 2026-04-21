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
let cachedIndexAssets: { iconHref: string; stylesheetHref: string } | null = null;

export async function readAdminIndexHtml(): Promise<string> {
  if (cachedIndexHtml) return cachedIndexHtml;
  const distDir = adminDistDirFrom(import.meta.url);
  cachedIndexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
  return cachedIndexHtml;
}

export async function readAdminIndexAssetUrls(): Promise<{
  iconHref: string;
  stylesheetHref: string;
}> {
  if (cachedIndexAssets) return cachedIndexAssets;
  let html: string;
  try {
    html = await readAdminIndexHtml();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (process.env.NODE_ENV !== 'production' && code === 'ENOENT') {
      return { iconHref: '', stylesheetHref: '' };
    }
    throw err;
  }
  cachedIndexAssets = {
    iconHref: html.match(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/i)?.[1] ?? '',
    stylesheetHref:
      html.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/i)?.[1] ?? '',
  };
  return cachedIndexAssets;
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
