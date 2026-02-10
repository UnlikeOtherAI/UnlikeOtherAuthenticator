import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClientConfig } from './config.service.js';
import { AppError } from '../utils/errors.js';

function repoRootFrom(metaUrl: string): string {
  // Works in both src/ and dist/ because the relative depth from this file to repo root is stable:
  // API/src/services/*  -> ../../..
  // API/dist/services/* -> ../../..
  const here = path.dirname(fileURLToPath(metaUrl));
  return path.resolve(here, '../../../');
}

function authDistDirFrom(metaUrl: string): string {
  return path.join(repoRootFrom(metaUrl), 'Auth', 'dist');
}

function escapeJsonForHtmlScriptTag(value: unknown): string {
  // Prevents `</script>` injection by escaping `<`.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

let cachedIndexHtml: string | null = null;

async function readAuthIndexHtml(): Promise<string> {
  if (cachedIndexHtml) return cachedIndexHtml;
  const distDir = authDistDirFrom(import.meta.url);
  cachedIndexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
  return cachedIndexHtml;
}

export async function renderAuthEntrypointHtml(params: {
  config: ClientConfig;
  configUrl: string;
}): Promise<string> {
  const base = await readAuthIndexHtml();

  const bootstrap = [
    '<script>',
    `window.__UOA_CLIENT_CONFIG__ = ${escapeJsonForHtmlScriptTag(params.config)};`,
    `window.__UOA_CONFIG_URL__ = ${escapeJsonForHtmlScriptTag(params.configUrl)};`,
    '</script>',
  ].join('');

  // Ensure the bootstrap runs before the Auth bundle executes.
  const moduleScriptIdx = base.toLowerCase().indexOf('<script type="module"');
  if (moduleScriptIdx !== -1) {
    return `${base.slice(0, moduleScriptIdx)}${bootstrap}${base.slice(moduleScriptIdx)}`;
  }

  const headCloseIdx = base.toLowerCase().lastIndexOf('</head>');
  if (headCloseIdx !== -1) {
    return `${base.slice(0, headCloseIdx)}${bootstrap}${base.slice(headCloseIdx)}`;
  }

  // Fail open for HTML formatting differences; ensure bootstrap is still present.
  return `${bootstrap}${base}`;
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
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

export async function readAuthUiAsset(params: {
  // e.g. "assets/index-abc.js" (no leading slash)
  relativePath: string;
}): Promise<{ body: Buffer; contentType: string }> {
  const distDir = authDistDirFrom(import.meta.url);

  // Basic traversal hardening.
  const rel = params.relativePath.replace(/^\/+/, '');
  const normalized = path.normalize(rel);
  if (!normalized || normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  const abs = path.join(distDir, normalized);
  const distPrefix = distDir.endsWith(path.sep) ? distDir : `${distDir}${path.sep}`;
  if (!abs.startsWith(distPrefix)) {
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
  const ext = path.extname(abs).toLowerCase();
  return { body, contentType: contentTypeForExt(ext) };
}
