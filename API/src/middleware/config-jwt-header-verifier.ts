import type { FastifyReply, FastifyRequest } from 'fastify';

import { getEnv } from '../config/env.js';
import {
  validateConfigFields,
  verifyConfigJwtSignature,
  type ClientConfig,
} from '../services/config.service.js';
import { normalizeDomain } from '../utils/domain.js';
import { AppError } from '../utils/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    config?: ClientConfig;
    configJwt?: string;
  }
}

function readHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

export async function configJwtHeaderVerifier(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  void reply;

  const configJwt = readHeader(request.headers['x-uoa-config-jwt']);
  if (!configJwt) throw new AppError('UNAUTHORIZED', 401);

  const jwksUrl = getEnv().CONFIG_JWKS_URL ?? 'https://invalid.local/.well-known/jwks.json';
  const payload = await verifyConfigJwtSignature(configJwt, jwksUrl);
  const config = validateConfigFields(payload);
  if (!normalizeDomain(config.domain)) throw new AppError('BAD_REQUEST', 400);

  request.configJwt = configJwt;
  request.config = config;
}
