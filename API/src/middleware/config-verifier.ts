import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireEnv } from '../config/env.js';
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
    throw new AppError('BAD_REQUEST', 400);
  }

  // Task 2.2: fetch the signed config JWT from the client-provided URL.
  request.configJwt = await fetchConfigJwtFromUrl(config_url);

  // Task 2.3 + 2.6: verify JWT signature using the shared secret and enforce expected `aud`.
  const payload = await verifyConfigJwtSignature(
    request.configJwt,
    SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER,
  );

  // Shared secret must never be exposed in the config payload that is later rendered
  // into HTML and hydrated by the Auth UI. Reject any config that contains the secret.
  if (containsSecretValue(payload, SHARED_SECRET)) {
    throw new AppError('BAD_REQUEST', 400);
  }

  // Task 2.4 + 2.5: validate required config fields + parse optional config fields.
  request.config = validateConfigFields(payload);

  // Task 2.8: validate domain claim matches the origin (host) of the config URL.
  assertConfigDomainMatchesConfigUrl(request.config.domain, config_url);
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
