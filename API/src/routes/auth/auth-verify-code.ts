import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireEnv } from '../../config/env.js';
import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { runWithRequestAdminTransaction } from '../../plugins/tenant-context.plugin.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { buildWorkspaceChoices } from '../../services/first-login.service.js';
import { verifyLoginCode } from '../../services/login-code.service.js';
import { signLoginSession } from '../../services/login-session.service.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { resolveProductWorkspaceBeforeTwoFa } from '../../services/required-workspace-placement.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/workspace-finalize.service.js';
import { lockProductWorkspacePolicyShared } from '../../services/product-workspace-policy-lock.service.js';
import { AppError } from '../../utils/errors.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { verifyCodeRateLimiter } from './rate-limit-keys.js';

const BodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    code: z.string().trim().min(1).max(16),
    remember_me: z.boolean().optional(),
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

/**
 * Phase 3b (design §4.3): verify a LOGIN_CODE issued by /auth/start. On success:
 * - `workspace_selection: "auto"` — mint a `login_token` bridge and return the workspace chooser
 *   payload (teams/pending_invites/can_create_org). 2FA is deferred to /auth/select-team for the
 *   selected org (design §11.2 flow order: identity → chooser → 2FA → redirect).
 * - `workspace_selection: "off"` (default) — skip the chooser and finalize immediately.
 *   Recognized products still pre-bind their server-owned exact workspace before 2FA.
 */
export function registerAuthVerifyCodeRoute(app: FastifyInstance): void {
  app.post(
    '/auth/verify-code',
    {
      preHandler: [verifyCodeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { email, code, remember_me } = BodySchema.parse(request.body);
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);
      const pkce = parseRequiredPkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }
      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });
      const rememberMe = remember_me ?? config.session?.remember_me_default ?? true;
      const requestAccess = parseRequestAccessFlag(request_access);

      const { userId, credentialEpoch } = await verifyLoginCode(
        { email, config, code },
        { prisma: request.adminDb },
      );

      if (config.login_flow?.workspace_selection === 'auto') {
        const chooser = await runWithRequestAdminTransaction(request, async (prisma) => {
          await lockProductWorkspacePolicyShared(prisma);
          await lockAndAssertAuthenticationEpoch(
            { userId, domain: config.domain, credentialEpoch },
            { prisma },
          );
          const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
          const loginToken = await signLoginSession({
            userId,
            credentialEpoch,
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
          const choices = await buildWorkspaceChoices({ userId, config }, { prisma });
          return { loginToken, choices };
        });
        reply.status(200).send({ login_token: chooser.loginToken, ...chooser.choices });
        return;
      }

      const outcome = await runWithRequestAdminTransaction(request, async (prisma) => {
        await lockProductWorkspacePolicyShared(prisma);
        const authenticationState = await lockAndAssertAuthenticationEpoch(
          { userId, domain: config.domain, credentialEpoch },
          { prisma },
        );
        const selectedWorkspace = await resolveProductWorkspaceBeforeTwoFa(
          { userId, config },
          { prisma, workspacePrisma: prisma },
        );

        const result = await finalizeWithTwoFaPolicy(
          {
            userId,
            credentialEpoch,
            twoFaEnabled: authenticationState.twoFaEnabled,
            config,
            configUrl,
            redirectUrl,
            rememberMe,
            requestAccess,
            authMethod: 'email_code',
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            ip: request.ip ?? null,
            ...(selectedWorkspace ?? {}),
          },
          {
            currentTwoFaEnabled: authenticationState.twoFaEnabled,
            policyLockHeld: true,
            policyPrisma: prisma,
            prisma,
            twoFaPolicyPrisma: prisma,
            workspacePrisma: prisma,
          },
        );

        if (result.kind === 'granted') {
          try {
            await recordLoginLog(
              {
                userId,
                email,
                domain: config.domain,
                authMethod: 'email_code',
                ip: request.ip ?? null,
                userAgent:
                  typeof request.headers['user-agent'] === 'string'
                    ? request.headers['user-agent']
                    : null,
              },
              { prisma },
            );
          } catch (err) {
            request.log.error({ err }, 'failed to record login log');
          }
        }

        return result;
      });

      if (outcome.kind === 'twofa') {
        reply
          .status(200)
          .send({ ok: true, twofa_required: true, twofa_token: outcome.twofa_token });
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

      reply.status(200).send({
        ok: true,
        code: outcome.finalResult.status === 'granted' ? outcome.finalResult.code : undefined,
        redirect_to: outcome.finalResult.redirectTo,
        access_request_status: outcome.finalResult.status === 'requested' ? 'pending' : undefined,
      });
    },
  );
}
