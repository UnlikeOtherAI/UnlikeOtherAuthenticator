import { fetch as undiciFetch } from 'undici';

import { AppError } from '../utils/errors.js';
import {
  closeSsrfAgent,
  createPinnedAgent,
  parseHttpsUrl,
  resolvePublicDestinations,
} from '../utils/ssrf.js';
import { parsePublicRsaJwks, type PublicRsaJwks } from './client-jwk.service.js';

const DEFAULT_JWKS_FETCH_TIMEOUT_MS = 5_000;
const MAX_JWKS_RESPONSE_BYTES = 64 * 1024;
const MAX_JWKS_FETCH_REDIRECTS = 3;

async function cancelResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Ignore cancellation failures while rejecting or redirecting.
  }
}

async function readBodyWithLimit(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_JWKS_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetch a partner JWKS document over HTTPS with SSRF protection.
 * Reuses the same IP-allowlist, DNS pinning, redirect cap, and size limits as the
 * config-JWT fetch pipeline. Returns a validated public-RSA JWKS (rejects any
 * private member or non-RSA key).
 */
export async function fetchPartnerJwks(
  jwksUrl: string,
  opts?: { timeoutMs?: number },
): Promise<PublicRsaJwks> {
  let url: URL;
  try {
    url = parseHttpsUrl(jwksUrl);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_URL_INVALID');
  }

  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_JWKS_FETCH_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    redirectLoop:
    for (let redirectCount = 0; redirectCount <= MAX_JWKS_FETCH_REDIRECTS; redirectCount++) {
      let destinations;
      try {
        destinations = await resolvePublicDestinations(url);
      } catch {
        throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_DESTINATION_REJECTED');
      }

      let lastNetworkError: unknown;

      for (const destination of destinations) {
        const agent = createPinnedAgent(url, destination);
        try {
          const res = await undiciFetch(url.toString(), {
            method: 'GET',
            headers: { accept: 'application/json, application/jwk-set+json' },
            redirect: 'manual',
            signal: controller.signal,
            dispatcher: agent,
          });

          if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get('location');
            await cancelResponseBody(res);
            if (!location || redirectCount === MAX_JWKS_FETCH_REDIRECTS) {
              throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_TOO_MANY_REDIRECTS');
            }
            try {
              url = parseHttpsUrl(new URL(location, url).toString());
            } catch {
              throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_REDIRECT_REJECTED');
            }
            continue redirectLoop;
          }

          if (!res.ok) {
            await cancelResponseBody(res);
            throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_HTTP_STATUS_REJECTED');
          }

          const buffer = await readBodyWithLimit(res);
          const text = buffer.toString('utf8').trim();
          if (!text) {
            throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_EMPTY');
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_NOT_JSON');
          }

          return parsePublicRsaJwks(parsed);
        } catch (err) {
          if (err instanceof AppError) throw err;
          lastNetworkError = err;
        } finally {
          await closeSsrfAgent(agent);
        }
      }

      if (lastNetworkError) {
        throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_NETWORK_ERROR');
      }
    }

    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_TOO_MANY_REDIRECTS');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('BAD_REQUEST', 400, 'INTEGRATION_JWKS_FETCH_FAILED');
  } finally {
    clearTimeout(timeoutId);
  }
}
