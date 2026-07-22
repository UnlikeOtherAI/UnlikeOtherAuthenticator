import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { runInTransaction } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { buildWorkspaceChoices } from '../../services/first-login.service.js';
import { verifyLoginSession } from '../../services/login-session.service.js';
import { lockProductWorkspacePolicyShared } from '../../services/product-workspace-policy-lock.service.js';
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
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
      const session = await verifyLoginSession({
        token: login_token,
        config,
        configUrl,
        sharedSecret: SHARED_SECRET,
        audience: LOGIN_SESSION_AUDIENCE,
      });

      const choices = await runInTransaction(request.adminDb, async (tx) => {
        await lockProductWorkspacePolicyShared(tx);
        await lockAndAssertAuthenticationEpoch(
          {
            userId: session.userId,
            domain: session.domain,
            credentialEpoch: session.credentialEpoch,
          },
          { prisma: tx },
        );
        const lockedSession = await verifyLoginSession({
          token: login_token,
          config,
          configUrl,
          sharedSecret: SHARED_SECRET,
          audience: LOGIN_SESSION_AUDIENCE,
          now: new Date(),
        });
        return buildWorkspaceChoices({ userId: lockedSession.userId, config }, { prisma: tx });
      });

      reply.status(200).send({ ...choices });
    },
  );
}
