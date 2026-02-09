import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { fetchConfigJwtFromUrl } from '../services/config.service.js';

const QuerySchema = z.object({
  config_url: z.string().min(1),
});

declare module 'fastify' {
  interface FastifyRequest {
    configUrl?: string;
    configJwt?: string;
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
  // Verification/parsing/validation are handled in subsequent tasks.
  request.configJwt = await fetchConfigJwtFromUrl(config_url);
}
