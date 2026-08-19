import { renderSVG } from '@unlikeotherai/qr-art';
import { fetch } from 'undici';

import { TOTP_QR_LOGO_DEADLINE_MS, TOTP_QR_LOGO_MAX_BYTES } from '../config/constants.js';
import { getAppLogger } from '../utils/app-logger.js';
import { AppError } from '../utils/errors.js';
import {
  closeSsrfAgent,
  createPinnedAgent,
  parseHttpsUrl,
  resolvePublicDestinations,
} from '../utils/ssrf.js';

type LogoFetchResponse = {
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: unknown;
};

type LogoFetch = (
  url: string,
  init: Record<string, unknown>,
) => Promise<LogoFetchResponse>;

export type LogoFetchDeps = {
  fetchLogo?: LogoFetch;
  /** Overall wall-clock budget for the whole fetch. Tests inject a short one. */
  deadlineMs?: number;
};

function assertOtpAuthUri(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed || !trimmed.startsWith('otpauth://')) {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_OTPAUTH_URI');
  }
  return trimmed;
}

async function inlineLogoUrl(logoUrl: string, deps?: LogoFetchDeps): Promise<string> {
  const trimmed = logoUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:image/')) return trimmed;

  // A malformed or non-HTTPS logo URL is a caller (config) error, not a fetch failure, so it
  // keeps throwing INVALID_LOGO_URL. Everything past this point is a logo the guard refused or
  // the network could not deliver: a logo is decoration, so — like the provider-avatar fetch in
  // Docs/Auth/avatars.md ("fail closed to the generated image") — those degrade to a QR without
  // a logo instead of failing 2FA enrolment. No SSRF control is weakened: the guard still
  // refuses, only the consequence changes.
  let url: URL;
  try {
    url = parseHttpsUrl(trimmed);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'INVALID_LOGO_URL');
  }

  const doFetch = deps?.fetchLogo ?? (fetch as unknown as LogoFetch);
  const deadlineMs =
    typeof deps?.deadlineMs === 'number' && deps.deadlineMs > 0
      ? deps.deadlineMs
      : TOTP_QR_LOGO_DEADLINE_MS;

  try {
    return await withLogoDeadline((signal) => fetchLogoImage(url, doFetch, signal), deadlineMs);
  } catch (err) {
    logLogoFetchFailure(trimmed, err);
    return '';
  }
}

/** Operator visibility for a tenant whose logo cannot be fetched: reason only, never the body. */
function logLogoFetchFailure(logoUrl: string, err: unknown): void {
  const reason =
    err instanceof AppError ? err.message : err instanceof Error ? err.name : 'unknown';
  try {
    getAppLogger().warn({ logoUrl, reason }, 'TOTP QR logo fetch failed; rendering without logo');
  } catch {
    // Logger not initialized (unit tests, scripts): the degraded QR is the contract.
  }
}

/**
 * The logo URL comes from a signed client config whose publisher controls their own DNS, so it is
 * attacker-supplied: the whole fetch — DNS resolution, every sequential address attempt, the
 * request, and the read — runs under one wall-clock deadline, exactly like the provider-avatar
 * fetch. The race is what makes the bound a guarantee: a leg that ignores its signal (unabortable
 * DNS, a hostile socket, an injected fetch) still cannot hold the caller past the deadline.
 */
async function withLogoDeadline(
  run: (signal: AbortSignal) => Promise<string>,
  deadlineMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED'));
    }, deadlineMs);
  });

  const attempt = run(controller.signal);

  try {
    return await Promise.race([attempt, expired]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function fetchLogoImage(
  url: URL,
  doFetch: LogoFetch,
  signal: AbortSignal,
): Promise<string> {
  // DNS-to-private rebinding fails here: only publicly routable destinations proceed.
  let destinations;
  try {
    destinations = await resolvePublicDestinations(url);
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');
  }

  let lastError: unknown;
  for (const destination of destinations) {
    if (signal.aborted) throw new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');

    // The agent is pinned to the already-validated address so DNS cannot be rebound between the
    // check and the connect, and redirects are refused rather than followed to an unvalidated host.
    const agent = createPinnedAgent(url, destination);
    try {
      return await requestLogoImage(doFetch, url, agent, signal);
    } catch (err) {
      lastError = err;
      // Try the next resolved address; a total failure ends as LOGO_FETCH_FAILED below.
    } finally {
      await closeSsrfAgent(agent);
    }
  }

  throw lastError instanceof AppError ? lastError : new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');
}

async function requestLogoImage(
  doFetch: LogoFetch,
  url: URL,
  agent: unknown,
  signal: AbortSignal,
): Promise<string> {
  const res = await doFetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'image/*' },
    redirect: 'error',
    signal,
    dispatcher: agent,
  });

  // Every exit below has to leave the response body released: an abandoned body keeps its request
  // active on the pinned agent, which is exactly what closeSsrfAgent waits on in the finally above.
  try {
    if (!res.ok) throw new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');

    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
    if (!contentType.startsWith('image/')) throw new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');

    const bytes = await readCappedLogoBody(res, TOTP_QR_LOGO_MAX_BYTES);
    if (!bytes || bytes.length === 0) throw new AppError('BAD_REQUEST', 400, 'LOGO_FETCH_FAILED');

    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } finally {
    await releaseLogoBody(res);
  }
}

/** Cancel (stream) or destroy (Node stream) whatever is left of the response body. */
async function releaseLogoBody(res: LogoFetchResponse): Promise<void> {
  const body = res.body as
    | { cancel?: () => Promise<unknown>; destroy?: () => unknown; locked?: boolean }
    | null
    | undefined;
  if (!body || typeof body !== 'object') return;

  try {
    if (typeof body.cancel === 'function' && body.locked !== true) {
      await body.cancel();
      return;
    }
    if (typeof body.destroy === 'function') body.destroy();
  } catch {
    // Nothing left to release.
  }
}

/**
 * Read the response body, refusing anything over `max` bytes. Streams when the runtime gives us an
 * async-iterable body so an oversized response is abandoned mid-flight rather than fully buffered;
 * falls back to a buffered read (still size-checked) otherwise. Callers release the body.
 */
async function readCappedLogoBody(res: LogoFetchResponse, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;

  const stream = res.body as AsyncIterable<Uint8Array> | null | undefined;
  if (
    !stream ||
    typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function'
  ) {
    const buffered = Buffer.from(await res.arrayBuffer());
    return buffered.byteLength > max ? null : buffered;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > max) return null;
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export async function renderTotpQrSvg(
  params: { otpAuthUri: string; logoUrl?: string | null },
  deps?: LogoFetchDeps,
): Promise<string> {
  const otpAuthUri = assertOtpAuthUri(params.otpAuthUri);
  const logoSrc = params.logoUrl ? await inlineLogoUrl(params.logoUrl, deps) : '';

  const svg = renderSVG(otpAuthUri, {
    size: 384,
    shape: 'square',
    cornerRadius: 0.25,
    margin: 4,
    logo: logoSrc
      ? {
          src: logoSrc,
          overlay: true,
          sizeRatio: 0.22,
          padding: 10,
          borderRadius: 16,
        }
      : undefined,
  });

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
