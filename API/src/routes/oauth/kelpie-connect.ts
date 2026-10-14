import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { PUBLIC_ERROR_MESSAGE } from '../../config/constants.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { issueKelpieConnectionTicket, validateKelpieConnectionTicket } from '../../services/oauth/kelpie-connect.service.js';
import { kelpieConnectResource } from '../../services/oauth/kelpie-connect-policy.js';
import { AppError } from '../../utils/errors.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

export function registerKelpieConnectRoutes(app: FastifyInstance): void {
  void app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    routes.setErrorHandler((error, _request, reply) => {
      const status = error instanceof AppError ? error.statusCode : error instanceof ZodError ? 400 :
        error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      reply.status(status).send({ error: PUBLIC_ERROR_MESSAGE });
    });
    const preHandler = [requireMcpOAuthPublicProfile, async () => { kelpieConnectResource(); }];
    routes.post('/oauth/kelpie/connect', { preHandler: [...preHandler,
      createRateLimiter({ limit: 120, windowMs: 60_000, keyBuilder: (request) => `kelpie-connect:issue:${request.ip}` })],
    }, async (request) => {
      const { resource } = z.object({ resource: z.string().min(1).max(2048) }).strict().parse(request.body);
      return issueKelpieConnectionTicket({ resource, authorization: request.headers.authorization }, request.adminDb);
    });
    routes.post('/oauth/kelpie/connect/validate', {
      preHandler: [...preHandler, requireDomainHashAuthForDomainQuery(),
        // A gateway validates many devices; native issuance must not exhaust its revocation checks.
        createRateLimiter({ limit: 12000, windowMs: 60_000,
          keyBuilder: () => `kelpie-connect:validate:${new URL(kelpieConnectResource()).host}` })],
    }, async (request) => {
      const { domain } = z.object({ domain: z.string().min(1).max(253) }).strict().parse(request.query);
      const { ticket } = z.object({ ticket: z.string().min(1).max(8192) }).strict().parse(request.body);
      const domainCredential = request.domainAuthCredential;
      if (!domainCredential) throw new AppError('UNAUTHORIZED', 401);
      return validateKelpieConnectionTicket({ domain, ticket, domainCredential }, request.adminDb);
    });
  });
}
