import type { FastifyInstance } from 'fastify';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { authorizePublicAccount, verifyPublicAccountToken } from '../../services/oauth/account.service.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';
import { registerBrowserAccountRoutes } from './browser-account.js';

export function registerOAuthAccountRoutes(app: FastifyInstance): void {
  registerBrowserAccountRoutes(app, { prefix: '/oauth',
    preHandler: [requireMcpOAuthPublicProfile, createRateLimiter({ limit: 120, windowMs: 60_000,
      keyBuilder: request => `oauth-account:${request.ip}` })],
    verify: verifyPublicAccountToken, authorize: authorizePublicAccount,
  });
}
