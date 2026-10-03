import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { startLifecycleStatus, verifyLifecycleStatus } from '../../services/lifecycle-status.service.js';
import { getOAuthClient } from '../../services/oauth/client.service.js';
import { buildMcpClientConfig } from '../../services/oauth/config.service.js';
import { AppError } from '../../utils/errors.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

async function context(request: FastifyRequest) {
  const query = z.object({ client_id: z.string().min(1).max(256), redirect_uri: z.string().min(1).max(2048) }).strict().parse(request.query);
  const client = await getOAuthClient(query.client_id);
  if (!client || !client.redirectUris.includes(query.redirect_uri)) throw new AppError('UNAUTHORIZED', 401);
  return { config: buildMcpClientConfig(client.redirectUris, client.nativeApp),
    native: { clientId: client.clientId, redirectUri: query.redirect_uri, revision: client.nativeAppRevision ?? 0 },
    configUrl: `native-status:${client.clientId}:${client.nativeAppRevision ?? 0}:${query.redirect_uri}` };
}
export function registerOAuthLifecycleStatus(app: FastifyInstance) {
  const options = { preHandler: [requireMcpOAuthPublicProfile, createRateLimiter({ limit: 10, windowMs: 15 * 60_000, keyBuilder: r => `native-lifecycle:${r.ip}` })] };
  app.post('/oauth/lifecycle-status/start', options, async request => {
    const body = z.object({ email: z.string().email().max(320) }).strict().parse(request.body);
    return startLifecycleStatus({ ...await context(request), ...body });
  });
  app.post('/oauth/lifecycle-status/verify', options, async request => {
    const body = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/), twoFactorCode: z.string().regex(/^\d{6}$/).optional() }).strict().parse(request.body);
    return verifyLifecycleStatus({ ...await context(request), ...body });
  });
}
