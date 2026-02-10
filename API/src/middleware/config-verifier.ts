import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireEnv } from '../config/env.js';
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

  // Task 2.2: fetch the signed config JWT from the client-provided URL.
  request.configJwt = await fetchConfigJwtFromUrl(config_url);

  // Task 2.3 + 2.6: verify JWT signature using the shared secret and enforce expected `aud`.
  const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
    'SHARED_SECRET',
    'AUTH_SERVICE_IDENTIFIER',
  );
  const payload = await verifyConfigJwtSignature(
    request.configJwt,
    SHARED_SECRET,
    AUTH_SERVICE_IDENTIFIER,
  );

  // Task 2.4 + 2.5: validate required config fields + parse optional config fields.
  request.config = validateConfigFields(payload);

  // Task 2.8: validate domain claim matches the origin (host) of the config URL.
  assertConfigDomainMatchesConfigUrl(request.config.domain, config_url);
}
