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
import { getTeamInviteLandingData } from '../../services/team-invite.service.js';
import {
  buildSessionChoices,
  resolveAutoSelectedTeam,
  shouldPresentTeamChooser,
  type AutoSelectedTeam,
} from '../../services/first-login.service.js';
import { signLoginSession } from '../../services/login-session.service.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { resolveProductTeamBeforeTwoFa } from '../../services/required-team-placement.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/team-finalize.service.js';
import { lockProductTeamPolicyShared } from '../../services/product-team-policy-lock.service.js';
import { parsePkceChallenge } from '../../utils/pkce.js';
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
    // Opaque relying-party CSRF value. UOA does not interpret it; it is bound to
    // this login and echoed verbatim on the final redirect.
    state: z.string().min(1).max(2048).optional(),
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
      const { redirect_url, code_challenge, code_challenge_method, request_access, state } =
        QuerySchema.parse(request.query);
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const pkce = parsePkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });
      if (!pkce) {
        // Only a live invitation may create an account outside an OAuth initiation. Standard
        // registration links still require PKCE before their token can be consumed.
        await getTeamInviteLandingData(
          { token, configUrl, config },
          { prisma: request.adminDb },
        );
      }

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

      const { userId, credentialEpoch, type, twoFaEnabled, acceptedInvite } =
        await verifyEmailToken(
          {
            token,
            password,
            config,
            configUrl,
          },
          { prisma: request.adminDb },
        );

      if (!pkce) {
        if (!acceptedInvite) {
          throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN');
        }
        reply.status(200).send({ ok: true, invite_accepted: true });
        return;
      }

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
        await lockProductTeamPolicyShared(tx);
        const authenticationState = await lockAndAssertAuthenticationEpoch(
          { userId, domain: config.domain, credentialEpoch },
          { prisma: tx, fallbackTwoFaEnabled: twoFaEnabled },
        );

        // Hold first-placement selection through exact-scope policy evaluation and code issuance.
        // The admin transaction preserves intentional cross-product and accepted-invite reads.
        let selectedTeam: AutoSelectedTeam | null = acceptedInvite
          ? { orgId: acceptedInvite.orgId, teamId: acceptedInvite.teamId }
          : null;
        if (!acceptedInvite && config.login_flow?.team_selection === 'auto') {
          const choices = await buildSessionChoices(
            { userId, config },
            { crossProductPrisma: tx, policyPrisma: tx, prisma: tx },
          );
          selectedTeam = resolveAutoSelectedTeam(choices);
          if (shouldPresentTeamChooser(choices, selectedTeam)) {
            const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
            const loginToken = await signLoginSession({
              userId,
              credentialEpoch,
              authMethod,
              config,
              configUrl,
              redirectUrl,
              rememberMe,
              requestAccess,
              state,
              codeChallenge: pkce.codeChallenge,
              codeChallengeMethod: pkce.codeChallengeMethod,
              sharedSecret: SHARED_SECRET,
              audience: LOGIN_SESSION_AUDIENCE,
            });
            return { kind: 'team_chooser' as const, choices, loginToken };
          }
        }
        selectedTeam ??= await resolveProductTeamBeforeTwoFa(
          { userId, config },
          { prisma: tx, teamPrisma: tx },
        );

        const outcome = await finalizeWithTwoFaPolicy(
          {
            userId,
            credentialEpoch,
            twoFaEnabled,
            config,
            configUrl,
            redirectUrl,
            state,
            rememberMe,
            requestAccess,
            authMethod,
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            ip: request.ip ?? null,
            ...(selectedTeam ?? {}),
          },
          {
            currentTwoFaEnabled: authenticationState.twoFaEnabled,
            policyLockHeld: true,
            policyPrisma: tx,
            prisma: tx,
            twoFaPolicyPrisma: tx,
            teamPrisma: tx,
          },
        );
        return { kind: 'finalized' as const, outcome };
      });

      if (continuation.kind === 'team_chooser') {
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
