import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireEnv } from '../config/env.js';
import {
  createAuthDebugInfo,
  formatZodIssues,
  mergeAuthDebugInfo,
} from '../services/auth-debug-page.service.js';
import { AppError } from '../utils/errors.js';
import {
  assertConfigDomainMatchesConfigUrl,
  fetchConfigJwtFromUrl,
  validateConfigFields,
  verifyConfigJwtSignature,
  type ClientConfig,
} from '../services/config.service.js';

const QuerySchema = z.object({
  config_url: z.string().min(1),
});

declare module 'fastify' {
  interface FastifyRequest {
    configUrl?: string;
    configJwt?: string;
    config?: ClientConfig;
  }
}

export async function configVerifier(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;
  const { config_url } = QuerySchema.parse(request.query);
  request.configUrl = config_url;
  request.authDebug = createAuthDebugInfo({ requestUrl: request.raw.url });

  // Shared secret must never be exposed publicly. Defensively reject requests that
  // try to embed it in the config URL (even though clients should never do this).
  const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
    'SHARED_SECRET',
    'AUTH_SERVICE_IDENTIFIER',
  );
  if (
    config_url.includes(SHARED_SECRET) ||
    config_url.includes(encodeURIComponent(SHARED_SECRET))
  ) {
    mergeAuthDebugInfo(request, {
      stage: 'config_url',
      code: 'CONFIG_URL_REJECTED',
      summary: 'The supplied config_url was rejected before any network request was made.',
    });
    throw new AppError('BAD_REQUEST', 400, 'CONFIG_URL_REJECTED');
  }

  // Task 2.2: fetch the signed config JWT from the client-provided URL.
  try {
    request.configJwt = await fetchConfigJwtFromUrl(config_url);
  } catch (err) {
    mergeAuthDebugInfo(request, {
      stage: 'config_fetch',
      code: 'CONFIG_FETCH_FAILED',
      summary: 'The auth service could not fetch a usable config JWT from config_url.',
    });
    throw err;
  }

  // Task 2.3 + 2.6: verify JWT signature using the shared secret and enforce expected `aud`.
  let payload;
  try {
    payload = await verifyConfigJwtSignature(
      request.configJwt,
      SHARED_SECRET,
      AUTH_SERVICE_IDENTIFIER,
    );
  } catch (err) {
    mergeAuthDebugInfo(request, {
      stage: 'config_verify',
      code: 'CONFIG_JWT_INVALID',
      summary: 'The fetched config JWT could not be verified for this auth service.',
    });
    throw err;
  }

  // Shared secret must never be exposed in the config payload that is later rendered
  // into HTML and hydrated by the Auth UI. Reject any config that contains the secret.
  if (containsSecretValue(payload, SHARED_SECRET)) {
    mergeAuthDebugInfo(request, {
      stage: 'config_verify',
      code: 'CONFIG_PAYLOAD_SECRET_REJECTED',
      summary: 'The fetched config payload contained a forbidden secret value.',
    });
    throw new AppError('BAD_REQUEST', 400, 'CONFIG_PAYLOAD_SECRET_REJECTED');
  }

  // Task 2.4 + 2.5: validate required config fields + parse optional config fields.
  try {
    request.config = validateConfigFields(payload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      mergeAuthDebugInfo(request, {
        stage: 'config_schema',
        code: 'CONFIG_SCHEMA_INVALID',
        summary: 'The config JWT passed fetch and signature checks but failed schema validation.',
        details: formatZodIssues(err),
      });
      throw new AppError('BAD_REQUEST', 400, 'CONFIG_SCHEMA_INVALID');
    }
    throw err;
  }

  // Task 2.8: validate domain claim matches the origin (host) of the config URL.
  try {
    assertConfigDomainMatchesConfigUrl(request.config.domain, config_url);
  } catch (err) {
    mergeAuthDebugInfo(request, {
      stage: 'config_domain',
      code: 'CONFIG_DOMAIN_MISMATCH',
      summary: 'The config JWT domain does not match the hostname of config_url.',
    });
    throw err;
  }
}

function containsSecretValue(value: unknown, secret: string): boolean {
  // Keep this conservative and cheap: we only scan for string matches.
  // The secret should never appear anywhere in user-controlled config payloads.
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();

  while (stack.length) {
    const current = stack.pop();
    if (current == null) continue;

    if (typeof current === 'string') {
      if (current === secret) return true;
      if (secret.length >= 8 && current.includes(secret)) return true;
      continue;
    }

    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    for (const v of Object.values(current as Record<string, unknown>)) {
      stack.push(v);
    }
  }

  return false;
}
