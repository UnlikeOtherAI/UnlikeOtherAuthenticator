import type { FastifyReply, FastifyRequest } from 'fastify';

import { getEnv } from '../config/env.js';
import {
  validateConfigFields,
  verifyConfigJwtSignatureWithKeyDomain,
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
  const { payload, keyDomain } = await verifyConfigJwtSignatureWithKeyDomain(configJwt, jwksUrl);
  const config = validateConfigFields(payload);
  const configDomain = normalizeDomain(config.domain);
  if (!configDomain) throw new AppError('BAD_REQUEST', 400);
  if (keyDomain && normalizeDomain(keyDomain) !== configDomain) {
    throw new AppError('BAD_REQUEST', 400);
  }
  if (getEnv().DATABASE_URL && !keyDomain) {
    throw new AppError('BAD_REQUEST', 400);
  }

  request.configJwt = configJwt;
  request.config = config;
}
