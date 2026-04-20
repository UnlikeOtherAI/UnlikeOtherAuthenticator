import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { AppError } from '../utils/errors.js';

const DEFAULT_CONFIG_FETCH_TIMEOUT_MS = 5_000;
const MAX_CONFIG_JWT_RESPONSE_BYTES = 64 * 1024;
const MAX_CONFIG_FETCH_REDIRECTS = 3;

function parseHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (url.protocol !== 'https:') {
    throw new AppError('BAD_REQUEST', 400);
  }

  return url;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const parsed = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const num = Number(part);
    return num >= 0 && num <= 255 ? num : Number.NaN;
  });

  return parsed.every((part) => Number.isInteger(part)) ? parsed : null;
}

function isBlockedIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return true;

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : '';
  if (mappedIpv4.includes('.')) {
    return isBlockedIpv4(mappedIpv4);
  }

  const first = normalized.split(':')[0] ?? '';
  const firstHextet = Number.parseInt(first || '0', 16);

  return (
    normalized === '::' ||
    normalized === '::1' ||
    (Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfe80) ||
    (Number.isInteger(firstHextet) && (firstHextet & 0xfe00) === 0xfc00)
  );
}

function isBlockedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

async function assertPublicDestination(url: URL): Promise<void> {
  if (isIP(url.hostname)) {
    if (isBlockedIpAddress(url.hostname)) {
      throw new AppError('BAD_REQUEST', 400);
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (!addresses.length || addresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new AppError('BAD_REQUEST', 400);
  }
}

function extractJwtFromBody(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return '';

  // Common convenience: allow "Bearer <jwt>" responses.
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice('bearer '.length).trim();
  }

  // Some client backends may return JSON. Support a minimal shape without overfitting.
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim();
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const candidate = obj.jwt ?? obj.token ?? obj.config_jwt ?? obj.configJwt ?? obj.configJWT;
        if (typeof candidate === 'string') return candidate.trim();
      }
    } catch {
      // Fall through and treat as plain text.
    }
  }

  return trimmed;
}

async function readResponseTextWithLimit(res: Response): Promise<string> {
  if (!res.body) return '';

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > MAX_CONFIG_JWT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError('BAD_REQUEST', 400);
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total).toString('utf8');
}

export async function fetchConfigJwtFromUrl(
  configUrl: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  let url = parseHttpsUrl(configUrl);
  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONFIG_FETCH_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let redirectCount = 0; redirectCount <= MAX_CONFIG_FETCH_REDIRECTS; redirectCount++) {
      await assertPublicDestination(url);

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'text/plain, application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location || redirectCount === MAX_CONFIG_FETCH_REDIRECTS) {
          throw new AppError('BAD_REQUEST', 400);
        }

        url = parseHttpsUrl(new URL(location, url).toString());
        continue;
      }

      if (!res.ok) {
        throw new AppError('BAD_REQUEST', 400);
      }

      const jwt = extractJwtFromBody(await readResponseTextWithLimit(res));
      if (!jwt) {
        throw new AppError('BAD_REQUEST', 400);
      }

      return jwt;
    }

    throw new AppError('BAD_REQUEST', 400);
  } catch (err) {
    // Normalize fetch/network/abort errors into a generic, user-safe error.
    if (err instanceof AppError) throw err;
    throw new AppError('BAD_REQUEST', 400);
  } finally {
    clearTimeout(timeoutId);
  }
}
