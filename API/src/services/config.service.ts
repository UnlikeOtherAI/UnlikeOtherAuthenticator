import { AppError } from '../utils/errors.js';

const DEFAULT_CONFIG_FETCH_TIMEOUT_MS = 5_000;

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
        const candidate =
          obj.jwt ?? obj.token ?? obj.config_jwt ?? obj.configJwt ?? obj.configJWT;
        if (typeof candidate === 'string') return candidate.trim();
      }
    } catch {
      // Fall through and treat as plain text.
    }
  }

  return trimmed;
}

export async function fetchConfigJwtFromUrl(
  configUrl: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  let url: URL;
  try {
    url = new URL(configUrl);
  } catch {
    throw new AppError('BAD_REQUEST', 400);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('BAD_REQUEST', 400);
  }

  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONFIG_FETCH_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'text/plain, application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const jwt = extractJwtFromBody(await res.text());
    if (!jwt) {
      throw new AppError('BAD_REQUEST', 400);
    }

    return jwt;
  } catch (err) {
    // Normalize fetch/network/abort errors into a generic, user-safe error.
    if (err instanceof AppError) throw err;
    throw new AppError('BAD_REQUEST', 400);
  } finally {
    clearTimeout(timeoutId);
  }
}

