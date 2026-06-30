import type { FastifyReply, FastifyRequest } from 'fastify';

import { verifyAdminApiKey } from '../services/admin-api-key.service.js';
import { API_KEY_PREFIX } from '../utils/api-key.js';
import { AppError } from '../utils/errors.js';
import { requireAdminSuperuser } from './admin-superuser.js';

// HUGO-539: combined guard for the flag/kill-switch write routes + GET /internal/admin/apps.
// An Admin API key credential, when present, is authoritative — a bad/expired/revoked key
// returns 401 and NEVER falls back to the superuser JWT. Only requests with no API-key
// credential fall through to requireAdminSuperuser, so the Admin UI is unaffected.

declare module 'fastify' {
  interface FastifyRequest {
    adminApiKey?: { id: string };
  }
}

/**
 * Reject a header value that arrived more than once. Node's HTTP parser surfaces duplicate
 * request headers either as an array or — more commonly — joined with ", ". A legitimate
 * Admin API key / Bearer token never contains a comma (base64url), so a comma is proof of a
 * smuggled second value; both shapes throw a generic 401.
 */
function assertSingleHeader(value: string | string[]): string {
  if (Array.isArray(value) || value.includes(',')) throw new AppError('UNAUTHORIZED', 401);
  return value;
}

/**
 * Extract a single Admin API-key credential from the request, or null when none is present.
 * Accepts `X-API-Key: <key>` or `Authorization: Bearer uoa_ak_…`. A present X-API-Key
 * is authoritative: empty means 401 and never falls back to JWT. Array/duplicate header
 * values are rejected (401) — an attacker must not smuggle a second value past the guard.
 */
function readApiKeyCredential(request: FastifyRequest): string | null {
  const apiKeyHeader = request.headers['x-api-key'];
  if (apiKeyHeader !== undefined) {
    const value = assertSingleHeader(apiKeyHeader).trim();
    if (!value) throw new AppError('UNAUTHORIZED', 401);
    return value;
  }

  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' || Array.isArray(authHeader)) {
    const trimmed = assertSingleHeader(authHeader).trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      const token = trimmed.slice('bearer '.length).trim();
      if (token.startsWith(API_KEY_PREFIX)) return token;
    }
  }

  return null;
}

export function requireAdminApiKeyOrSuperuser() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const apiKey = readApiKeyCredential(request);
    if (apiKey) {
      request.adminApiKey = await verifyAdminApiKey(apiKey);
      return;
    }
    return requireAdminSuperuser(request, reply);
  };
}
