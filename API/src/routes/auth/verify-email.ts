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
import {
  buildWorkspaceChoices,
  resolveAutoSelectedWorkspace,
  shouldPresentWorkspaceChooser,
  type AutoSelectedWorkspace,
} from '../../services/first-login.service.js';
import { signLoginSession } from '../../services/login-session.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import {
  parseRequestAccessFlag,
} from '../../services/access-request-flow.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/workspace-finalize.service.js';
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

      const { userId, type, twoFaEnabled, acceptedInvite } = await verifyEmailToken(
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
      const rememberMe = request.config.session?.remember_me_default ?? true;
      const requestAccess = parseRequestAccessFlag(request_access);

      // An accepted email invite is already an explicit workspace selection and always bypasses the
      // chooser. Otherwise auto mode either selects the sole team or exposes every real action,
      // including the zero-team "create workspace" entrypoint.
      let selectedWorkspace: AutoSelectedWorkspace | null = acceptedInvite
        ? { orgId: acceptedInvite.orgId, teamId: acceptedInvite.teamId }
        : null;
      if (!acceptedInvite && request.config.login_flow?.workspace_selection === 'auto') {
        const choices = await buildWorkspaceChoices(
          { userId, config: request.config },
          { prisma: request.adminDb },
        );
        selectedWorkspace = resolveAutoSelectedWorkspace(choices);
        if (shouldPresentWorkspaceChooser(choices, selectedWorkspace)) {
          const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
          const loginToken = await signLoginSession({
            userId,
            config: request.config,
            configUrl: request.configUrl,
            redirectUrl,
            rememberMe,
            requestAccess,
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            sharedSecret: SHARED_SECRET,
            audience: LOGIN_SESSION_AUDIENCE,
          });
          reply.status(200).send({ login_token: loginToken, ...choices });
          return;
        }
      }

      const authMethod =
        type === 'LOGIN_LINK'
          ? 'login_link'
          : type === 'VERIFY_EMAIL'
            ? 'verify_email'
            : 'verify_email_set_password';
      const outcome = await finalizeWithTwoFaPolicy(
        {
          userId,
          twoFaEnabled,
          config: request.config,
          configUrl: request.configUrl,
          redirectUrl,
          rememberMe,
          requestAccess,
          authMethod,
          codeChallenge: pkce.codeChallenge,
          codeChallengeMethod: pkce.codeChallengeMethod,
          ip: request.ip ?? null,
          ...(selectedWorkspace ?? {}),
        },
        { prisma: request.adminDb },
      );

      if (outcome.kind === 'twofa') {
        reply.status(200).send({
          ok: true,
          twofa_required: true,
          twofa_token: outcome.twofa_token,
        });
        return;
      }

      if (outcome.kind === 'twofa_enroll_required') {
        reply.status(200).send({
          ok: true,
          kind: 'twofa_enroll_required',
          twofa_enroll_required: true,
          ...outcome.setup,
        });
        return;
      }

      try {
        await recordLoginLog(
          {
            userId,
            domain: request.config.domain,
            authMethod,
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
        code: outcome.finalResult.status === 'granted' ? outcome.finalResult.code : undefined,
        redirect_to: outcome.finalResult.redirectTo,
        access_request_status: outcome.finalResult.status === 'requested' ? 'pending' : undefined,
      });
    },
  );
}
