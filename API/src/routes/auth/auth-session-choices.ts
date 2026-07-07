import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { buildWorkspaceChoices } from '../../services/first-login.service.js';
import { verifyLoginSession } from '../../services/login-session.service.js';
import { AppError } from '../../utils/errors.js';
import { sessionChoicesRateLimiter } from './rate-limit-keys.js';

const BodySchema = z
  .object({
    login_token: z.string().min(1).max(4096),
  })
  .strict();

// Only `config_url` is consumed here; extra flow query params (redirect_url, code_challenge, ...)
// the SPA already carries for the other /auth/* calls are harmless and simply ignored.
const QuerySchema = z.object({
  config_url: z.string().min(1).max(2048),
});

/**
 * Phase 3b Task 7 follow-up (design §4.3, §11.2): the primitive the SPA calls to hydrate the
 * workspace-chooser payload after landing via a redirect that seeded a `login_token` bridge
 * instead of inlining the payload (the social callback is a GET redirect, unlike
 * `/auth/verify-code` and `/auth/login`, which can return the chooser inline). Verifies the
 * bridge token exactly like `/auth/select-team` does and rejects (generically) on any failure —
 * it only ever answers for an already-verified `login_token`, so it introduces no enumeration.
 */
export function registerAuthSessionChoicesRoute(app: FastifyInstance): void {
  app.post(
    '/auth/session-choices',
    {
      preHandler: [sessionChoicesRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { login_token } = BodySchema.parse(request.body);
      QuerySchema.parse(request.query);

      const config = request.config;
      if (!config) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
      const session = await verifyLoginSession({
        token: login_token,
        domain: config.domain,
        sharedSecret: SHARED_SECRET,
        audience: LOGIN_SESSION_AUDIENCE,
      });

      const choices = await buildWorkspaceChoices(
        { userId: session.userId, config },
        { prisma: request.adminDb },
      );

      reply.status(200).send({ ...choices });
    },
  );
}
