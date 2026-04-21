import type { FastifyRequest } from 'fastify';

import type { ConfigFetchDiagnostics } from './config-fetch-diagnostics.service.js';

const urlQueryKeys = /url|uri/i;
const exactSensitiveQueryKeys = new Set([
  'authorization',
  'code',
  'id_token',
  'jwt',
  'state',
]);

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    exactSensitiveQueryKeys.has(normalized) ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('verifier')
  );
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

function sanitizeExternalUrl(value: string, redactions: string[], path: string): string {
  try {
    const url = new URL(value);
    if (url.search || url.hash) {
      url.search = '';
      url.hash = '';
      redactions.push(path);
    }
    return url.toString();
  } catch {
    return '[invalid_url]';
  }
}

function sanitizeAuthRequestUrl(rawUrl: string | undefined, redactions: string[]): string {
  if (!rawUrl) return '';

  try {
    const url = new URL(rawUrl, 'http://uoa.local');
    for (const [key, value] of url.searchParams.entries()) {
      const path = `request.auth_request.query.${key}`;
      if (isSensitiveQueryKey(key)) {
        url.searchParams.set(key, '[redacted]');
        redactions.push(path);
      } else if (urlQueryKeys.test(key)) {
        url.searchParams.set(key, sanitizeExternalUrl(value, redactions, path));
      } else if (value.length > 160) {
        url.searchParams.set(key, `${value.slice(0, 160)}...[truncated]`);
        redactions.push(`${path}:truncated`);
      }
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return '[invalid_url]';
  }
}

function sanitizeAuthRequestQuery(rawUrl: string | undefined, redactions: string[]): Record<string, unknown> {
  if (!rawUrl) return {};

  try {
    const url = new URL(rawUrl, 'http://uoa.local');
    const query: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      const path = `request.auth_request.query.${key}`;
      if (isSensitiveQueryKey(key)) {
        query[key] = '[redacted]';
        redactions.push(path);
      } else if (urlQueryKeys.test(key)) {
        query[key] = sanitizeExternalUrl(value, redactions, path);
      } else if (value.length > 160) {
        query[key] = `${value.slice(0, 160)}...[truncated]`;
        redactions.push(`${path}:truncated`);
      } else {
        query[key] = value;
      }
    }
    return query;
  } catch {
    return {};
  }
}

function requestHeaders(request: FastifyRequest, redactions: string[]): Record<string, unknown> {
  const headers = request.headers;
  const referer = stringHeader(headers.referer);
  return {
    host: stringHeader(headers.host),
    origin: stringHeader(headers.origin),
    referer: referer ? sanitizeExternalUrl(referer, redactions, 'request.auth_request.headers.referer') : undefined,
    user_agent: stringHeader(headers['user-agent']),
    x_forwarded_for: stringHeader(headers['x-forwarded-for']),
    x_forwarded_host: stringHeader(headers['x-forwarded-host']),
    x_forwarded_proto: stringHeader(headers['x-forwarded-proto']),
    x_cloud_trace_context: stringHeader(headers['x-cloud-trace-context']),
    cf_ray: stringHeader(headers['cf-ray']),
  };
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
}

export function buildHandshakeRequestJson(params: {
  configFetchRequest?: Record<string, unknown>;
  configUrl: string;
  redactions: string[];
  request: FastifyRequest;
}): Record<string, unknown> {
  const { configFetchRequest, configUrl, redactions, request } = params;
  return {
    auth_request: compactObject({
      id: request.id,
      method: request.method,
      url: sanitizeAuthRequestUrl(request.raw.url, redactions),
      path: sanitizeAuthRequestUrl(request.url, redactions).split('?')[0],
      query: compactObject(sanitizeAuthRequestQuery(request.raw.url, redactions)),
      ip: request.ip,
      headers: compactObject(requestHeaders(request, redactions)),
    }),
    config_fetch_request:
      configFetchRequest ??
      {
        method: 'GET',
        config_url: sanitizeExternalUrl(configUrl, redactions, 'request.config_fetch_request.config_url'),
        source: 'query.config_url',
      },
  };
}

export function configFetchFailureDetails(
  configUrl: string,
  diagnostics: ConfigFetchDiagnostics | null,
): string[] {
  const redactions: string[] = [];
  const safeConfigUrl =
    typeof diagnostics?.request.config_url === 'string'
      ? diagnostics.request.config_url
      : sanitizeExternalUrl(configUrl, redactions, 'details.config_url');
  const response = diagnostics?.response ?? {};
  const details = [`Config fetch attempted: GET ${safeConfigUrl}`];

  if (typeof response.reason === 'string') details.push(`Fetch reason: ${response.reason}.`);
  if (typeof response.final_url === 'string') details.push(`Final URL: ${response.final_url}.`);
  if (typeof response.status === 'number') {
    const statusText = typeof response.status_text === 'string' ? ` ${response.status_text}` : '';
    details.push(`Config endpoint HTTP status: ${response.status}${statusText}.`);
  }
  if (typeof response.error === 'string') details.push(`Network/runtime error: ${response.error}.`);
  if (typeof response.content_type === 'string' && response.content_type) {
    details.push(`Response content type: ${response.content_type}.`);
  }
  if (!diagnostics) {
    details.push('This revision did not capture lower-level fetch diagnostics.');
  }

  details.push('No JWT header or payload is available because the config_url fetch did not return a usable JWT.');
  return details;
}
