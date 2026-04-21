import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getAuthServiceIdentifier, requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { loginWithEmailPassword } from '../../services/auth-login.service.js';
import {
  finalizeAuthenticatedUser,
  parseRequestAccessFlag,
} from '../../services/access-request-flow.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { signTwoFaChallenge } from '../../services/twofactor-challenge.service.js';
import { selectRedirectUrl } from '../../services/token.service.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { loginRateLimiter } from './rate-limit-keys.js';

const LoginBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
    remember_me: z.boolean().optional(),
  })
  .strict();

const LoginQuerySchema = z
  .object({
    config_url: z.string().min(1),
    redirect_url: z.string().min(1).optional(),
    code_challenge: z.string().min(1).optional(),
    code_challenge_method: z.string().min(1).optional(),
    request_access: z.string().optional(),
  })
  .strict();

export function registerAuthLoginRoute(app: FastifyInstance): void {
  app.post(
    '/auth/login',
    {
      preHandler: [loginRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { email, password, remember_me } = LoginBodySchema.parse(request.body);
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        LoginQuerySchema.parse(request.query);
      const pkce = parseRequiredPkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      // configVerifier guarantees request.config is set on success.
      const config = request.config;
      if (!config) {
        // Defensive: should never happen; still keep the error generic via global handler.
        throw new Error('missing request.config');
      }
      if (!request.configUrl) {
        throw new Error('missing request.configUrl');
      }

      const { userId, twoFaEnabled } = await loginWithEmailPassword({ email, password, config });

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });

      const rememberMe = remember_me ?? config.session?.remember_me_default ?? true;

      // Brief 13 / Phase 8.6 + 8.7: enforce 2FA verification during login when enabled via config.
      if (config['2fa_enabled'] && twoFaEnabled) {
        const { SHARED_SECRET } = requireEnv('SHARED_SECRET');

        const twofa_token = await signTwoFaChallenge({
          userId,
          domain: config.domain,
          configUrl: request.configUrl,
          redirectUrl,
          authMethod: 'email_password',
          rememberMe,
          requestAccess: parseRequestAccessFlag(request_access),
          codeChallenge: pkce.codeChallenge,
          codeChallengeMethod: pkce.codeChallengeMethod,
          sharedSecret: SHARED_SECRET,
          audience: getAuthServiceIdentifier(),
        });

        reply.status(200).send({ ok: true, twofa_required: true, twofa_token });
        return;
      }

      const finalResult = await finalizeAuthenticatedUser({
        userId,
        config,
        configUrl: request.configUrl,
        redirectUrl,
        rememberMe,
        requestAccess: parseRequestAccessFlag(request_access),
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
      });

      try {
        await recordLoginLog({
          userId,
          email,
          domain: config.domain,
          authMethod: 'email_password',
          ip: request.ip ?? null,
          userAgent:
            typeof request.headers['user-agent'] === 'string'
              ? request.headers['user-agent']
              : null,
        });
      } catch (err) {
        request.log.error({ err }, 'failed to record login log');
      }

      reply.status(200).send({
        ok: true,
        code: finalResult.status === 'granted' ? finalResult.code : undefined,
        redirect_to: finalResult.redirectTo,
        access_request_status: finalResult.status === 'requested' ? 'pending' : undefined,
      });
    },
  );
}
