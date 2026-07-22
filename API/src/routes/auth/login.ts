import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { getAuthServiceIdentifier, requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { runWithRequestAdminTransaction } from '../../plugins/tenant-context.plugin.js';
import { loginWithEmailPassword } from '../../services/auth-login.service.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import {
  finalizeAuthenticatedUser,
  parseRequestAccessFlag,
} from '../../services/access-request-flow.service.js';
import { buildWorkspaceChoices } from '../../services/first-login.service.js';
import { signLoginSession } from '../../services/login-session.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import {
  lockProductWorkspacePolicyShared,
} from '../../services/product-workspace-policy-lock.service.js';
import { resolveTwoFaPolicy } from '../../services/twofactor-policy.service.js';
import { signTwoFaChallenge } from '../../services/twofactor-challenge.service.js';
import {
  startTwoFactorSetup,
  type TwoFactorSetupResult,
} from '../../services/twofactor-setup.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { loginRateLimiter } from './rate-limit-keys.js';

const LoginBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(1024),
    remember_me: z.boolean().optional(),
  })
  .strict();

const LoginQuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    redirect_url: z.string().min(1).max(2048).optional(),
    code_challenge: z.string().min(1).max(256).optional(),
    code_challenge_method: z.string().min(1).max(32).optional(),
    request_access: z.string().max(16).optional(),
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
      const configUrl = request.configUrl;
      if (!config) {
        // Defensive: should never happen; still keep the error generic via global handler.
        throw new Error('missing request.config');
      }
      if (!configUrl) {
        throw new Error('missing request.configUrl');
      }

      // The shared policy fence and its BYPASSRLS policy re-read must use the
      // same transaction as challenge/setup/code issuance.
      const outcome = await runWithRequestAdminTransaction(request, async (prisma) => {
        await lockProductWorkspacePolicyShared(prisma);
        const { userId, twoFaEnabled, credentialEpoch } = await loginWithEmailPassword(
          { email, password, config },
          { prisma },
        );
        const authenticationState = await lockAndAssertAuthenticationEpoch(
          { userId, domain: config.domain, credentialEpoch },
          { prisma, fallbackTwoFaEnabled: twoFaEnabled },
        );

        const redirectUrl = selectRedirectUrl({
          allowedRedirectUrls: config.redirect_urls,
          requestedRedirectUrl: redirect_url,
        });

        const rememberMe = remember_me ?? config.session?.remember_me_default ?? true;
        const requestAccess = parseRequestAccessFlag(request_access);

        const twoFaPolicy = await resolveTwoFaPolicy(
          {
            config,
            userId,
            orgId: requestAccess ? config.access_requests?.target_org_id : undefined,
          },
          { prisma },
        );
        if (twoFaPolicy !== 'OFF' && authenticationState.twoFaEnabled) {
          const { SHARED_SECRET } = requireEnv('SHARED_SECRET');

          const twofa_token = await signTwoFaChallenge({
            userId,
            credentialEpoch,
            domain: config.domain,
            configUrl,
            redirectUrl,
            authMethod: 'email_password',
            rememberMe,
            requestAccess,
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            sharedSecret: SHARED_SECRET,
            audience: getAuthServiceIdentifier(),
          });

          return { kind: 'twofa' as const, twofa_token };
        }

        if (twoFaPolicy === 'REQUIRED') {
          const setup = await startTwoFactorSetup(
            {
              userId,
              credentialEpoch,
              config,
              configUrl,
              finalize: {
                authMethod: 'email_password',
                redirectUrl,
                rememberMe,
                requestAccess,
                codeChallenge: pkce.codeChallenge,
                codeChallengeMethod: pkce.codeChallengeMethod,
              },
            },
            { prisma },
          );

          return { kind: 'twofa_enroll_required' as const, setup };
        }

        // Phase 3b Task 7 (design §4.3 item 4): with the chooser opted in, 2FA-satisfied logins
        // land on the workspace chooser instead of finalizing directly. 2FA ordering is preserved —
        // both branches above already returned before this point when 2FA still needs handling.
        if (config.login_flow?.workspace_selection === 'auto') {
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
            // Must match the audience verify-code/select-team/session-choices verify against
            // (LOGIN_SESSION_AUDIENCE), NOT the auth-service identifier — otherwise a password-login
            // login_token fails verifyLoginSession at select-team and the chooser flow breaks.
            audience: LOGIN_SESSION_AUDIENCE,
          });
          const choices = await buildWorkspaceChoices(
            { userId, config },
            {
              crossProductPrisma: request.adminDb,
              policyPrisma: request.adminDb,
              prisma,
            },
          );
          return { kind: 'workspace_chooser' as const, loginToken, choices };
        }

        const finalResult = await finalizeAuthenticatedUser(
          {
            userId,
            credentialEpoch,
            config,
            configUrl,
            redirectUrl,
            rememberMe,
            requestAccess,
            authMethod: 'email_password',
            twoFaCompleted: false,
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            ip: request.ip ?? null,
          },
          { workspacePrisma: request.adminDb, prisma },
        );

        try {
          await recordLoginLog(
            {
              userId,
              email,
              domain: config.domain,
              authMethod: 'email_password',
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

        return { kind: 'granted' as const, finalResult };
      });

      if (outcome.kind === 'twofa') {
        reply
          .status(200)
          .send({ ok: true, twofa_required: true, twofa_token: outcome.twofa_token });
        return;
      }

      if (outcome.kind === 'twofa_enroll_required') {
        const setup: TwoFactorSetupResult = outcome.setup;
        reply.status(200).send({
          ok: true,
          kind: 'twofa_enroll_required',
          twofa_enroll_required: true,
          ...setup,
        });
        return;
      }

      if (outcome.kind === 'workspace_chooser') {
        reply.status(200).send({ login_token: outcome.loginToken, ...outcome.choices });
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
