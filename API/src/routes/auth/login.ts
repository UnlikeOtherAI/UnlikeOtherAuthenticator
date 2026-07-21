import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import { loginWithEmailPassword } from '../../services/auth-login.service.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import {
  buildWorkspaceChoices,
  resolveAutoSelectedWorkspace,
  shouldPresentWorkspaceChooser,
  type AutoSelectedWorkspace,
} from '../../services/first-login.service.js';
import { signLoginSession } from '../../services/login-session.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { resolveProductWorkspaceBeforeTwoFa } from '../../services/required-workspace-placement.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/workspace-finalize.service.js';
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

      // Whole login runs under the verified domain's tenant context. userId is resolved
      // by loginWithEmailPassword inside the tx; app.user_id stays unset during the
      // email→user lookup (users policy only requires app.domain), then downstream
      // writes (auth code / login log) happen with the same domain scope.
      setTenantContextFromRequest(request, { orgId: null, userId: null });

      const outcome = await request.withTenantTx(async (tx) => {
        const prisma = asPrismaClient(tx);
        const { userId, twoFaEnabled } = await loginWithEmailPassword(
          { email, password, config },
          { prisma },
        );

        const redirectUrl = selectRedirectUrl({
          allowedRedirectUrls: config.redirect_urls,
          requestedRedirectUrl: redirect_url,
        });

        const rememberMe = remember_me ?? config.session?.remember_me_default ?? true;
        const requestAccess = parseRequestAccessFlag(request_access);

        let selectedWorkspace: AutoSelectedWorkspace | null = null;
        if (config.login_flow?.workspace_selection === 'auto') {
          const choices = await buildWorkspaceChoices(
            { userId, config },
            {
              crossProductPrisma: request.adminDb,
              policyPrisma: request.adminDb,
              prisma,
            },
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
              // Must match the audience verify-code/select-team/session-choices verify against.
              audience: LOGIN_SESSION_AUDIENCE,
            });
            return { kind: 'workspace_chooser' as const, loginToken, choices };
          }
        }

        selectedWorkspace ??= await resolveProductWorkspaceBeforeTwoFa(
          { userId, config },
          { prisma, workspacePrisma: request.adminDb },
        );

        const finalized = await finalizeWithTwoFaPolicy(
          {
            userId,
            twoFaEnabled,
            config,
            configUrl,
            redirectUrl,
            rememberMe,
            requestAccess,
            authMethod: 'email_password',
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            ip: request.ip ?? null,
            ...(selectedWorkspace ?? {}),
          },
          {
            twoFaPolicyPrisma: request.adminDb,
            workspacePrisma: request.adminDb,
            prisma,
          },
        );

        if (finalized.kind !== 'granted') return finalized;

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

        return finalized;
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
