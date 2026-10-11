import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { PUBLIC_ERROR_MESSAGE } from '../../config/constants.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { issueKelpiePairingTicket, validateKelpiePairingTicket } from '../../services/oauth/kelpie-pair.service.js';
import { AppError } from '../../utils/errors.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

const binding = z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), clientId: z.string().min(1).max(200) });

export function registerKelpiePairRoutes(app: FastifyInstance): void {
  void app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    routes.setErrorHandler((error, _request, reply) => {
      const status = error instanceof AppError ? error.statusCode : error instanceof ZodError ? 400 :
        error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      reply.status(status).send({ error: PUBLIC_ERROR_MESSAGE });
    });
    routes.post('/oauth/kelpie/pair', { preHandler: [requireMcpOAuthPublicProfile,
      createRateLimiter({ limit: 120, windowMs: 60_000, keyBuilder: (request) => `kelpie-pair:issue:${request.ip}` })],
    }, async (request) => {
      const input = binding.strict().parse(request.body);
      return issueKelpiePairingTicket({ ...input, authorization: request.headers.authorization }, request.adminDb);
    });
    routes.post('/oauth/kelpie/pair/validate', { preHandler: [requireMcpOAuthPublicProfile,
      createRateLimiter({ limit: 12000, windowMs: 60_000, keyBuilder: (request) => `kelpie-pair:validate:${request.ip}` })],
    }, async (request) => {
      const input = binding.extend({ ticket: z.string().min(1).max(8192) }).strict().parse(request.body);
      return validateKelpiePairingTicket({ ...input, authorization: request.headers.authorization }, request.adminDb);
    });
  });
}
