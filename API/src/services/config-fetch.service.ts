import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

import { AppError } from '../utils/errors.js';

const DEFAULT_CONFIG_FETCH_TIMEOUT_MS = 5_000;
const MAX_CONFIG_JWT_RESPONSE_BYTES = 64 * 1024;
const MAX_CONFIG_FETCH_REDIRECTS = 3;

type PublicDestination = {
  address: string;
  family: 4 | 6;
};

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

function ipv4PartsToHextets(parts: number[]): [number, number] {
  return [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]];
}

function parseIpv6Part(part: string): number[] | null {
  if (part.includes('.')) {
    const ipv4Parts = parseIpv4(part);
    return ipv4Parts ? ipv4PartsToHextets(ipv4Parts) : null;
  }

  if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
  return [Number.parseInt(part, 16)];
}

function parseIpv6Parts(parts: string[]): number[] | null {
  const hextets: number[] = [];
  for (const part of parts) {
    const parsed = parseIpv6Part(part);
    if (!parsed) return null;
    hextets.push(...parsed);
  }

  return hextets;
}

function expandIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) return null;

  const normalized = address.toLowerCase();
  const compressed = normalized.split('::');
  if (compressed.length > 2) return null;

  const left = compressed[0] ? compressed[0].split(':') : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(':') : [];
  const leftHextets = parseIpv6Parts(left);
  const rightHextets = parseIpv6Parts(right);
  if (!leftHextets || !rightHextets) return null;

  if (compressed.length === 1) {
    return leftHextets.length === 8 ? leftHextets : null;
  }

  const omittedCount = 8 - leftHextets.length - rightHextets.length;
  if (omittedCount < 1) return null;

  return [...leftHextets, ...Array<number>(omittedCount).fill(0), ...rightHextets];
}

function decodeTrailingIpv4(hextets: number[]): string {
  const high = hextets[6];
  const low = hextets[7];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isIpv4MappedIpv6(hextets: number[]): boolean {
  return hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;
}

function isNat64WellKnownPrefix(hextets: number[]): boolean {
  return (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets.slice(2, 6).every((hextet) => hextet === 0)
  );
}

function isNat64LocalUsePrefix(hextets: number[]): boolean {
  return hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2] === 0x0001;
}

function isBlockedIpv6(address: string): boolean {
  const hextets = expandIpv6(address);
  if (!hextets) return true;

  if (isIpv4MappedIpv6(hextets)) {
    return isBlockedIpv4(decodeTrailingIpv4(hextets));
  }

  if (isNat64WellKnownPrefix(hextets) || isNat64LocalUsePrefix(hextets)) return true;

  const isUnspecified = hextets.every((hextet) => hextet === 0);
  const isLoopback =
    hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1;
  const firstHextet = hextets[0];

  return (
    isUnspecified ||
    isLoopback ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xfe00) === 0xfc00 ||
    firstHextet >= 0xff00
  );
}

function stripIpv6Brackets(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

function isBlockedIpAddress(address: string): boolean {
  const normalizedAddress = stripIpv6Brackets(address);
  const family = isIP(normalizedAddress);
  if (family === 4) return isBlockedIpv4(normalizedAddress);
  if (family === 6) return isBlockedIpv6(normalizedAddress);
  return true;
}

async function resolvePublicDestinations(url: URL): Promise<PublicDestination[]> {
  const hostname = stripIpv6Brackets(url.hostname);
  const ipFamily = isIP(hostname);
  if (ipFamily === 4 || ipFamily === 6) {
    if (isBlockedIpAddress(hostname)) {
      throw new AppError('BAD_REQUEST', 400);
    }
    return [{ address: hostname, family: ipFamily }];
  }

  let addresses: PublicDestination[];
  try {
    const resolved = await lookup(url.hostname, { all: true, verbatim: true });
    addresses = resolved.map((entry) => {
      if (entry.family !== 4 && entry.family !== 6) {
        throw new AppError('BAD_REQUEST', 400);
      }
      return { address: entry.address, family: entry.family };
    });
  } catch {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (!addresses.length || addresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new AppError('BAD_REQUEST', 400);
  }

  return addresses;
}

function createPinnedAgent(url: URL, destination: PublicDestination): Agent {
  const servername = isIP(stripIpv6Brackets(url.hostname)) ? undefined : url.hostname;

  return new Agent({
    connect: {
      ...(servername ? { servername } : {}),
      lookup: (_hostname, _options, callback) => {
        callback(null, destination.address, destination.family);
      },
    },
  });
}

async function closeAgent(agent: Agent): Promise<void> {
  try {
    await agent.close();
  } catch {
    // Ignore close failures; fetch errors are handled separately.
  }
}

async function cancelResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Ignore cancellation failures while rejecting or redirecting.
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
    redirectLoop:
    for (let redirectCount = 0; redirectCount <= MAX_CONFIG_FETCH_REDIRECTS; redirectCount++) {
      const destinations = await resolvePublicDestinations(url);
      let lastNetworkError: unknown;

      for (const destination of destinations) {
        const agent = createPinnedAgent(url, destination);

        try {
          const res = await undiciFetch(url.toString(), {
            method: 'GET',
            headers: { accept: 'text/plain, application/json' },
            redirect: 'manual',
            signal: controller.signal,
            dispatcher: agent,
          });

          if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get('location');
            await cancelResponseBody(res);
            if (!location || redirectCount === MAX_CONFIG_FETCH_REDIRECTS) {
              throw new AppError('BAD_REQUEST', 400);
            }

            url = parseHttpsUrl(new URL(location, url).toString());
            continue redirectLoop;
          }

          if (!res.ok) {
            throw new AppError('BAD_REQUEST', 400);
          }

          const jwt = extractJwtFromBody(await readResponseTextWithLimit(res));
          if (!jwt) {
            throw new AppError('BAD_REQUEST', 400);
          }

          return jwt;
        } catch (err) {
          if (err instanceof AppError) throw err;
          lastNetworkError = err;
        } finally {
          await closeAgent(agent);
        }
      }

      if (lastNetworkError) throw lastNetworkError;
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
