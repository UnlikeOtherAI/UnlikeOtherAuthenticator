import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { AppError } from '../../utils/errors.js';
import {
  validateVerifyEmailToken,
  verifyEmailToken,
} from '../../services/auth-verify-email.service.js';
import { buildWorkspaceChoices } from '../../services/first-login.service.js';
import { signLoginSession } from '../../services/login-session.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import {
  finalizeAuthenticatedUser,
  parseRequestAccessFlag,
} from '../../services/access-request-flow.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const BodySchema = z
  .object({
    token: z.string().min(1).max(4096),
    password: z.string().min(1).max(1024).optional(),
  })
  .strict();

const QuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    redirect_url: z.string().min(1).max(2048).optional(),
    code_challenge: z.string().min(1).max(256).optional(),
    code_challenge_method: z.string().min(1).max(32).optional(),
    request_access: z.string().max(16).optional(),
  })
  .strict();

export function registerAuthVerifyEmailRoute(app: FastifyInstance): void {
  // Completes registration email verification. For password-required mode, a password is
  // required; for passwordless mode, token consumption signs the user in directly.
  app.post(
    '/auth/verify-email',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token, password } = BodySchema.parse(request.body);
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);
      const pkce = parseRequiredPkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const tokenType = await validateVerifyEmailToken(
        {
          token,
          config: request.config,
          configUrl: request.configUrl,
        },
        { prisma: request.adminDb },
      );

      if (tokenType === 'VERIFY_EMAIL_SET_PASSWORD' && !password) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_PASSWORD');
      }

      const { userId, type, teamInviteId } = await verifyEmailToken(
        {
          token,
          password,
          config: request.config,
          configUrl: request.configUrl,
        },
        { prisma: request.adminDb },
      );

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: request.config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });

      // Gap-fix B Task 1 (design §4.3, mirrors /auth/login's chooser gate): reuse the exact
      // login.ts pattern — return the JSON chooser payload instead of finalizing — UNLESS this
      // token was invite-bound (teamInviteId set), in which case verifyEmailToken already ran
      // acceptTeamInviteWithinTransaction above: the accepted invite IS the workspace selection,
      // so the chooser must NOT be interposed on top of it. Brand-new users normally have 0 teams
      // and 0 invites, so the gate auto-skips for them (nothing changes vs. today).
      if (!teamInviteId && request.config.login_flow?.workspace_selection === 'auto') {
        const choices = await buildWorkspaceChoices(
          { userId, config: request.config },
          { prisma: request.adminDb },
        );
        if (choices.teams.length >= 2 || choices.pending_invites.length > 0) {
          const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
          const loginToken = await signLoginSession({
            userId,
            domain: request.config.domain,
            sharedSecret: SHARED_SECRET,
            audience: LOGIN_SESSION_AUDIENCE,
          });
          reply.status(200).send({ login_token: loginToken, ...choices });
          return;
        }
      }

      const finalResult = await finalizeAuthenticatedUser(
        {
          userId,
          config: request.config,
          configUrl: request.configUrl,
          redirectUrl,
          rememberMe: request.config.session?.remember_me_default ?? true,
          requestAccess: parseRequestAccessFlag(request_access),
          codeChallenge: pkce.codeChallenge,
          codeChallengeMethod: pkce.codeChallengeMethod,
          ip: request.ip ?? null,
        },
        { prisma: request.adminDb },
      );

      try {
        await recordLoginLog(
          {
            userId,
            domain: request.config.domain,
            authMethod: type === 'VERIFY_EMAIL' ? 'verify_email' : 'verify_email_set_password',
            ip: request.ip ?? null,
            userAgent:
              typeof request.headers['user-agent'] === 'string'
                ? request.headers['user-agent']
                : null,
          },
          { prisma: request.adminDb },
        );
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
