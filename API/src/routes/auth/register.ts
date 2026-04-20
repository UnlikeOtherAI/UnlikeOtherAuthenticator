import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { requestRegistrationInstructions } from '../../services/auth-register.service.js';
import { parsePkceChallenge } from '../../utils/pkce.js';
import { registerRateLimiter } from './rate-limit-keys.js';

const SUCCESS_MESSAGE = 'We sent instructions to your email';

const RegisterBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();

const RegisterQuerySchema = z
  .object({
    redirect_url: z.string().min(1).optional(),
    code_challenge: z.string().min(1).optional(),
    code_challenge_method: z.string().min(1).optional(),
    request_access: z.string().optional(),
  })
  .passthrough();

export function registerAuthRegisterRoute(app: FastifyInstance): void {
  app.post(
    '/auth/register',
    {
      preHandler: [registerRateLimiter, configVerifier],
    },
    async (request, reply) => {
      // Brief 11: no email enumeration. Always return the same success message regardless
      // of whether the email exists, is new, or is malformed.
      const parsed = RegisterBodySchema.safeParse(request.body);
      const email = parsed.success ? parsed.data.email : null;
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        RegisterQuerySchema.parse(request.query);
      const pkce = parsePkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      if (email && request.config && request.configUrl) {
        try {
          await requestRegistrationInstructions({
            email,
            config: request.config,
            configUrl: request.configUrl,
            redirectUrl: redirect_url,
            requestAccess: parseRequestAccessFlag(request_access),
            codeChallenge: pkce?.codeChallenge,
            codeChallengeMethod: pkce?.codeChallengeMethod,
          });
        } catch (err) {
          // Never leak internal failures; always return the generic success response.
          request.log.error({ err }, 'registration instructions failed');
        }
      }

      reply.status(200).send({ message: SUCCESS_MESSAGE });
    },
  );
}
