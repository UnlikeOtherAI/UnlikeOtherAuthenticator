import { fetch as undiciFetch } from 'undici';

import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';
import {
  closeSsrfAgent,
  createPinnedAgent,
  parseHttpsUrl,
  resolvePublicDestinations,
} from '../utils/ssrf.js';
import { configFetchFailure, errorName, responseDiagnostics } from './config-fetch-diagnostics.service.js';

const DEFAULT_CONFIG_FETCH_TIMEOUT_MS = 5_000;
const MAX_CONFIG_JWT_RESPONSE_BYTES = 64 * 1024;
const MAX_CONFIG_FETCH_REDIRECTS = 3;

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
  let url: URL;
  try {
    url = parseHttpsUrl(configUrl);
  } catch {
    throw configFetchFailure(configUrl, 'INVALID_OR_NON_HTTPS_CONFIG_URL');
  }
  const originalHost = normalizeDomain(url.hostname);

  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONFIG_FETCH_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    redirectLoop:
    for (let redirectCount = 0; redirectCount <= MAX_CONFIG_FETCH_REDIRECTS; redirectCount++) {
      let destinations;
      try {
        destinations = await resolvePublicDestinations(url);
      } catch {
        throw configFetchFailure(configUrl, 'CONFIG_URL_DNS_OR_DESTINATION_REJECTED', {
          final_url: url.toString(),
        });
      }
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
              throw configFetchFailure(configUrl, location ? 'TOO_MANY_REDIRECTS' : 'REDIRECT_WITHOUT_LOCATION', {
                final_url: url.toString(),
                status: res.status,
                location: location ? new URL(location, url).toString() : null,
              });
            }

            let nextUrl: URL;
            try {
              nextUrl = parseHttpsUrl(new URL(location, url).toString());
            } catch {
              throw configFetchFailure(configUrl, 'REDIRECT_TARGET_REJECTED', {
                final_url: url.toString(),
                status: res.status,
              });
            }
            // Cross-host redirects are rejected so an open-redirect endpoint on
            // the partner's domain can't hand the config fetch off to a server
            // the partner does not control.
            if (normalizeDomain(nextUrl.hostname) !== originalHost) {
              throw configFetchFailure(configUrl, 'REDIRECT_CROSS_HOST_REJECTED', {
                final_url: url.toString(),
                redirect_to: nextUrl.toString(),
                status: res.status,
              });
            }
            url = nextUrl;
            continue redirectLoop;
          }

          if (!res.ok) {
            const redactions: string[] = [];
            const bodyText = await readResponseTextWithLimit(res).catch(() => '');
            throw configFetchFailure(
              configUrl,
              'CONFIG_URL_HTTP_STATUS_REJECTED',
              responseDiagnostics(res, url, bodyText, redactions),
              redactions,
            );
          }

          let bodyText: string;
          try {
            bodyText = await readResponseTextWithLimit(res);
          } catch {
            throw configFetchFailure(configUrl, 'CONFIG_RESPONSE_TOO_LARGE', {
              final_url: url.toString(),
              status: res.status,
            });
          }

          const jwt = extractJwtFromBody(bodyText);
          if (!jwt) {
            const redactions: string[] = [];
            throw configFetchFailure(
              configUrl,
              'CONFIG_RESPONSE_EMPTY',
              responseDiagnostics(res, url, bodyText, redactions),
              redactions,
            );
          }

          return jwt;
        } catch (err) {
          if (err instanceof AppError) throw err;
          lastNetworkError = err;
        } finally {
          await closeSsrfAgent(agent);
        }
      }

      if (lastNetworkError) {
        throw configFetchFailure(configUrl, 'CONFIG_URL_NETWORK_ERROR', {
          final_url: url.toString(),
          error: errorName(lastNetworkError),
        });
      }
    }

    throw configFetchFailure(configUrl, 'TOO_MANY_REDIRECTS');
  } catch (err) {
    // Normalize fetch/network/abort errors into a generic, user-safe error.
    if (err instanceof AppError) throw err;
    throw configFetchFailure(configUrl, 'CONFIG_FETCH_FAILED', { error: errorName(err) });
  } finally {
    clearTimeout(timeoutId);
  }
}
