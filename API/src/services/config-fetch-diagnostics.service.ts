import { AppError } from '../utils/errors.js';

const MAX_DIAGNOSTIC_TEXT_LENGTH = 500;

export type ConfigFetchDiagnostics = {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  redactions: string[];
};

export class ConfigFetchError extends AppError {
  public readonly diagnostics: ConfigFetchDiagnostics;

  public constructor(diagnostics: ConfigFetchDiagnostics) {
    super('BAD_REQUEST', 400, 'CONFIG_FETCH_FAILED');
    this.diagnostics = diagnostics;
  }
}

export function getConfigFetchDiagnostics(error: unknown): ConfigFetchDiagnostics | null {
  return error instanceof ConfigFetchError ? error.diagnostics : null;
}

export function configFetchFailure(
  configUrl: string,
  reason: string,
  response: Record<string, unknown> = {},
  responseRedactions: string[] = [],
): ConfigFetchError {
  const redactions = [...responseRedactions];
  const request = {
    method: 'GET',
    config_url: sanitizeDiagnosticUrl(configUrl, redactions, 'request.config_url'),
    accept: 'text/plain, application/json',
  };

  return new ConfigFetchError({
    request,
    response: sanitizeDiagnosticValue({ reason, ...response }, redactions, 'response') as Record<string, unknown>,
    redactions,
  });
}

export function responseDiagnostics(res: Response, url: URL, bodyText: string, redactions: string[]): Record<string, unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  return {
    final_url: sanitizeDiagnosticUrl(url.toString(), redactions, 'response.final_url'),
    status: res.status,
    status_text: res.statusText,
    content_type: contentType,
    body: sanitizeResponseBody(bodyText, contentType, redactions),
  };
}

export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

function trySanitizeDiagnosticUrl(value: string, redactions: string[], path: string): string | null {
  try {
    const url = new URL(value);
    if (url.search || url.hash) {
      url.search = '';
      url.hash = '';
      redactions.push(path);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeDiagnosticUrl(value: string, redactions: string[], path: string): string {
  return trySanitizeDiagnosticUrl(value, redactions, path) ?? '[invalid_url]';
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('jwt') ||
    normalized.includes('key') ||
    normalized === 'authorization'
  );
}

function sanitizeDiagnosticValue(value: unknown, redactions: string[], path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeDiagnosticValue(item, redactions, `${path}[${index}]`));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const nextPath = `${path}.${key}`;
        if (isSensitiveDiagnosticKey(key)) {
          redactions.push(nextPath);
          return [key, '[redacted]'];
        }
        return [key, sanitizeDiagnosticValue(item, redactions, nextPath)];
      }),
    );
  }

  if (typeof value !== 'string') return value;
  if (path.endsWith('_url') || path.endsWith('.url') || path.endsWith('.final_url') || path.endsWith('.location')) {
    const sanitizedUrl = trySanitizeDiagnosticUrl(value, redactions, path);
    if (sanitizedUrl) return sanitizedUrl;
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(value.trim())) {
    redactions.push(path);
    return '[redacted_jwt]';
  }
  if (/bearer\s+[A-Za-z0-9._-]+/i.test(value)) {
    redactions.push(path);
    return '[redacted_bearer]';
  }
  if (value.length > MAX_DIAGNOSTIC_TEXT_LENGTH) {
    redactions.push(`${path}:truncated`);
    return `${value.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}...[truncated]`;
  }
  return value;
}

function sanitizeResponseBody(bodyText: string, contentType: string, redactions: string[]): unknown {
  const trimmed = bodyText.trim();
  if (!trimmed) return '';

  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return sanitizeDiagnosticValue(JSON.parse(trimmed), redactions, 'response.body');
    } catch {
      // Fall through to text handling.
    }
  }

  if (/secret|password|passwd|credential|token|jwt|authorization|bearer|api[_ -]?key|access[_ -]?key|private[_ -]?key/i.test(trimmed)) {
    redactions.push('response.body');
    return '[redacted_non_json_body]';
  }

  return sanitizeDiagnosticValue(trimmed, redactions, 'response.body');
}
