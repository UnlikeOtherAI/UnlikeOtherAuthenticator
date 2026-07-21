import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { runInTransaction } from '../../db/tenant-context.js';
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
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { resolveProductWorkspaceBeforeTwoFa } from '../../services/required-workspace-placement.service.js';
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
      const config = request.config;
      const configUrl = request.configUrl;

      const tokenType = await validateVerifyEmailToken(
        {
          token,
          config,
          configUrl,
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
          config,
          configUrl,
        },
        { prisma: request.adminDb },
      );

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });
      const rememberMe = config.session?.remember_me_default ?? true;
      const requestAccess = parseRequestAccessFlag(request_access);

      const authMethod =
        type === 'LOGIN_LINK'
          ? 'login_link'
          : type === 'VERIFY_EMAIL'
            ? 'verify_email'
            : 'verify_email_set_password';
      const continuation = await runInTransaction(request.adminDb, async (tx) => {
        // The first-placement advisory lock must remain held until exact-scope finalization and
        // authorization-code issuance commit. Using the admin transaction also preserves the
        // cross-product and accepted-invite reads that intentionally bypass tenant RLS here.
        let selectedWorkspace: AutoSelectedWorkspace | null = acceptedInvite
          ? { orgId: acceptedInvite.orgId, teamId: acceptedInvite.teamId }
          : null;
        if (!acceptedInvite && config.login_flow?.workspace_selection === 'auto') {
          const choices = await buildWorkspaceChoices(
            { userId, config },
            { crossProductPrisma: tx, policyPrisma: tx, prisma: tx },
          );
          selectedWorkspace = resolveAutoSelectedWorkspace(choices);
          if (shouldPresentWorkspaceChooser(choices, selectedWorkspace)) {
            const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
            const loginToken = await signLoginSession({
              userId,
              config,
              configUrl,
              redirectUrl,
              rememberMe,
              requestAccess,
              codeChallenge: pkce.codeChallenge,
              codeChallengeMethod: pkce.codeChallengeMethod,
              sharedSecret: SHARED_SECRET,
              audience: LOGIN_SESSION_AUDIENCE,
            });
            return { kind: 'workspace_chooser' as const, choices, loginToken };
          }
        }
        selectedWorkspace ??= await resolveProductWorkspaceBeforeTwoFa(
          { userId, config },
          { prisma: tx, workspacePrisma: tx },
        );

        const outcome = await finalizeWithTwoFaPolicy(
          {
            userId,
            twoFaEnabled,
            config,
            configUrl,
            redirectUrl,
            rememberMe,
            requestAccess,
            authMethod,
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            ip: request.ip ?? null,
            ...(selectedWorkspace ?? {}),
          },
          {
            policyPrisma: tx,
            prisma: tx,
            twoFaPolicyPrisma: tx,
            workspacePrisma: tx,
          },
        );
        return { kind: 'finalized' as const, outcome };
      });

      if (continuation.kind === 'workspace_chooser') {
        reply.status(200).send({
          login_token: continuation.loginToken,
          ...continuation.choices,
        });
        return;
      }

      const { outcome } = continuation;

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
            domain: config.domain,
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
