import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireEnv } from '../config/env.js';
import {
  fetchConfigJwtFromUrl,
  validateRequiredConfigFields,
  verifyConfigJwtSignature,
  type RequiredClientConfig,
} from '../services/config.service.js';

const QuerySchema = z.object({
  config_url: z.string().min(1),
});

declare module 'fastify' {
  interface FastifyRequest {
    configUrl?: string;
    configJwt?: string;
    config?: RequiredClientConfig;
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

  // Task 2.3: verify JWT signature using the shared secret.
  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
  const payload = await verifyConfigJwtSignature(request.configJwt, SHARED_SECRET);

  // Task 2.4: validate required config fields.
  request.config = validateRequiredConfigFields(payload);
}
