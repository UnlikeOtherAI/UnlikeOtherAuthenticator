import type { FastifyInstance } from 'fastify';

import { getEnv } from '../config/env.js';
import { listActiveJwks, jwkToPublic, type PublicRsaJwk } from '../services/client-jwk.service.js';
import { readPublicConfigJwks } from '../services/config-jwks.service.js';

const configJwksResponseSchema = {
  type: 'object',
  required: ['keys'],
  properties: {
    keys: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
} as const;

function readLegacyEnvJwks(): PublicRsaJwk[] {
  if (!getEnv().CONFIG_JWKS_JSON) return [];
  try {
    return readPublicConfigJwks().keys as unknown as PublicRsaJwk[];
  } catch {
    return [];
  }
}

async function readDbJwks(): Promise<PublicRsaJwk[]> {
  if (!getEnv().DATABASE_URL) return [];
  const rows = await listActiveJwks();
  return rows.map((row) => jwkToPublic(row.jwk));
}

export function registerConfigJwksRoute(app: FastifyInstance): void {
  app.get(
    '/.well-known/jwks.json',
    { schema: { response: { 200: configJwksResponseSchema } } },
    async (_request, reply) => {
      const envKeys = readLegacyEnvJwks();
      const dbKeys = await readDbJwks();

      const seen = new Set<string>();
      const keys: PublicRsaJwk[] = [];
      for (const key of [...envKeys, ...dbKeys]) {
        if (seen.has(key.kid)) continue;
        seen.add(key.kid);
        keys.push(key);
      }

      reply.header('Cache-Control', 'public, max-age=60');
      reply.type('application/json; charset=utf-8').send({ keys });
    },
  );
}
