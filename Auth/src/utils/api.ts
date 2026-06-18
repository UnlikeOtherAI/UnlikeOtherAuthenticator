/**
 * Thin typed wrapper over fetch for the Auth SPA.
 *
 * The auth API returns either the expected JSON payload (2xx) or a generic
 * `{ error: 'Request failed' }` envelope. Some flows may also include a small
 * allowlisted machine-readable `code` so callers can pick the right i18n key.
 */

export type ApiSuccess<T> = {
  ok: true;
  status: number;
  data: T;
};

export type ApiFailure = {
  ok: false;
  status: number;
  /** The generic error string from `{ error }` if present, otherwise null. */
  error: string | null;
  /** Machine-readable public error code when the API intentionally exposes one. */
  code: string | null;
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type QueryValue = string | number | boolean | null | undefined;

function appendQuery(url: URL, query?: Record<string, QueryValue>): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  // Paths are always relative to the auth origin — the SPA lives in the
  // popup served by the same host as the API. Reject absolute URLs so a
  // stray `https://attacker.example/...` value can never bypass the base.
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) {
    throw new Error('Absolute URLs not permitted');
  }
  const url = new URL(path, window.location.origin);
  appendQuery(url, query);
  return url.toString();
}

function extractError(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === 'string') return e;
  }
  return null;
}

function extractCode(body: unknown): string | null {
  if (body && typeof body === 'object' && 'code' in body) {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: {
    query?: Record<string, QueryValue>;
    body?: unknown;
  } = {},
): Promise<ApiResult<T>> {
  const url = buildUrl(path, options.query);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, error: null, code: null };
  }

  const json = await parseJsonSafe(response);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: extractError(json),
      code: extractCode(json),
    };
  }

  return { ok: true, status: response.status, data: json as T };
}

export function getJson<TRes>(
  path: string,
  query?: Record<string, QueryValue>,
): Promise<ApiResult<TRes>> {
  return request<TRes>('GET', path, { query });
}

export function postJson<TReq, TRes>(
  path: string,
  body: TReq,
  query?: Record<string, QueryValue>,
): Promise<ApiResult<TRes>> {
  return request<TRes>('POST', path, { query, body });
}
