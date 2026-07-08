import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { requestRegistrationInstructions } from '../../services/auth-register.service.js';
import { issueLoginCode } from '../../services/login-code.service.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { authStartRateLimiter } from './rate-limit-keys.js';

const SUCCESS_MESSAGE = 'We sent instructions to your email';

const StartBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();

const StartQuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    redirect_url: z.string().min(1).max(2048).optional(),
    code_challenge: z.string().min(1).max(256).optional(),
    code_challenge_method: z.string().min(1).max(32).optional(),
    request_access: z.string().max(16).optional(),
  })
  .strict();

/**
 * Phase 3b (design §4.3): the Slack-style email-first entry point. A superset of
 * /auth/register — it keeps the existing magic-link behaviour unchanged and, only when
 * `config.login_flow.email_code_enabled` is true, additionally issues a 6-digit sign-in code.
 * Brief 11: the response is ALWAYS the same generic success message, regardless of whether the
 * email exists, is new, is malformed, or whether a code was actually issued.
 */
export function registerAuthStartRoute(app: FastifyInstance): void {
  app.post(
    '/auth/start',
    {
      preHandler: [authStartRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const parsed = StartBodySchema.safeParse(request.body);
      const email = parsed.success ? parsed.data.email : null;
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        StartQuerySchema.parse(request.query);
      const pkce = parseRequiredPkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      if (email && request.config && request.configUrl) {
        try {
          const result = await requestRegistrationInstructions(
            {
              email,
              config: request.config,
              configUrl: request.configUrl,
              redirectUrl: redirect_url,
              requestAccess: parseRequestAccessFlag(request_access),
              codeChallenge: pkce.codeChallenge,
              codeChallengeMethod: pkce.codeChallengeMethod,
            },
            { prisma: request.adminDb },
          );
          if (result.status === 'existing_user') {
            reply.status(409).send({
              error: 'Request failed',
              code: 'EMAIL_ALREADY_REGISTERED',
            });
            return;
          }
        } catch (err) {
          // Never leak internal failures; always return the generic success response.
          request.log.error({ err }, 'registration instructions failed');
        }

        if (request.config.login_flow?.email_code_enabled) {
          try {
            await issueLoginCode(
              {
                email,
                config: request.config,
                configUrl: request.configUrl,
              },
              { prisma: request.adminDb },
            );
          } catch (err) {
            // Best-effort and silent: a login-code failure must never change the generic
            // response or otherwise reveal whether the account exists.
            request.log.error({ err }, 'login code issuance failed');
          }
        }
      }

      reply.status(200).send({ message: SUCCESS_MESSAGE });
    },
  );
}
