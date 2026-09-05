import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { runInTransaction } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { consumeLoginSession } from '../../services/login-session-use.service.js';
import {
  assertLoginSessionContinuation,
  verifyLoginSession,
} from '../../services/login-session.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { createOrganisation } from '../../services/organisation.service.organisation.js';
import { lockProductTeamPolicyShared } from '../../services/product-team-policy-lock.service.js';
import { lockRequiredTeamPlacementUser } from '../../services/user-team-requirement.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/team-finalize.service.js';
import { lockAndAssertActiveClientTeamScope } from '../../services/team-scope.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { AppError } from '../../utils/errors.js';
import { selectTeamRateLimiter } from './rate-limit-keys.js';

const BodySchema = z
  .object({
    login_token: z.string().min(1).max(4096),
    name: z.string().trim().min(1).max(100),
    // The address the person chose in the dialog. Omitted derives one from the
    // name; supplied, it is validated and refused with a reason rather than
    // quietly rewritten.
    slug: z.string().trim().min(2).max(63).optional(),
    // The hosted dialog only exposes these three plainly-described visibility choices. Other
    // policies remain available through the organisation management API.
    join_policy: z.enum(['HIDDEN', 'INVITE_ONLY', 'OPEN_TO_ORG']).optional(),
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

function rejectOrganisationCreation(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

/**
 * Creates an organisation and its first team directly from the SSO chooser. The short-lived
 * login capability is consumed in the same transaction as the organisation,
 * its default team, and the next auth continuation, so a replay cannot leave a
 * duplicate tenant behind.
 */
export function registerAuthCreateOrganisationRoute(app: FastifyInstance): void {
  app.post(
    '/auth/create-organisation',
    { preHandler: [selectTeamRateLimiter, configVerifier] },
    async (request, reply) => {
      const { login_token, name, slug, join_policy, remember_me } = BodySchema.parse(request.body);
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');

      const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
      const session = await verifyLoginSession({
        token: login_token,
        config,
        configUrl,
        sharedSecret: SHARED_SECRET,
        audience: LOGIN_SESSION_AUDIENCE,
      });

      let redirectUrl: string;
      let pkce: ReturnType<typeof parseRequiredPkceChallenge>;
      try {
        redirectUrl = selectRedirectUrl({
          allowedRedirectUrls: config.redirect_urls,
          requestedRedirectUrl: redirect_url,
        });
        pkce = parseRequiredPkceChallenge({
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method,
        });
      } catch {
        rejectOrganisationCreation();
      }
      const requestAccess = parseRequestAccessFlag(request_access);
      assertLoginSessionContinuation(session, {
        redirectUrl,
        rememberMe: remember_me,
        requestAccess,
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
      });

      const outcome = await runInTransaction(request.adminDb, async (tx) => {
        await lockProductTeamPolicyShared(tx);
        await lockAndAssertAuthenticationEpoch(
          {
            userId: session.userId,
            domain: session.domain,
            credentialEpoch: session.credentialEpoch,
          },
          { prisma: tx },
        );
        const lockedSession = await verifyLoginSession({
          token: login_token,
          config,
          configUrl,
          sharedSecret: SHARED_SECRET,
          audience: LOGIN_SESSION_AUDIENCE,
          now: new Date(),
        });
        assertLoginSessionContinuation(lockedSession, {
          redirectUrl,
          rememberMe: remember_me,
          requestAccess,
          codeChallenge: pkce.codeChallenge,
          codeChallengeMethod: pkce.codeChallengeMethod,
        });
        if (
          config.login_flow?.team_selection !== 'auto' ||
          !config.org_features?.enabled ||
          !config.org_features.allow_user_create_org
        ) {
          rejectOrganisationCreation();
        }
        // A user can hold more than one independently-issued login bridge.
        // Serialize before the active-membership read in createOrganisation so
        // those bridges cannot create two first teams concurrently.
        await lockRequiredTeamPlacementUser(lockedSession.userId, { prisma: tx });

        // Claim before writing the new tenant. A later failure rolls the claim
        // and all team effects back, leaving a legitimate retry possible.
        await consumeLoginSession({
          domain: lockedSession.domain,
          jti: lockedSession.jti,
          expiresAtEpochSeconds: lockedSession.expiresAtEpochSeconds,
          prisma: tx,
          now: new Date(),
        });

        const organisation = await createOrganisation(
          {
            domain: config.domain,
            name,
            slug,
            defaultTeamJoinPolicy: join_policy,
            ownerId: lockedSession.userId,
            actorUserId: lockedSession.userId,
            config,
          },
          { prisma: tx, auditPrisma: tx },
        );
        const team = await tx.team.findFirst({
          where: { orgId: organisation.id, isDefault: true },
          select: { id: true },
        });
        if (!team) rejectOrganisationCreation();

        await lockAndAssertActiveClientTeamScope(
          {
            userId: lockedSession.userId,
            domain: config.domain,
            orgId: organisation.id,
            teamId: team.id,
          },
          { crossProductPrisma: tx, policyPrisma: tx, prisma: tx },
        );
        const user = await tx.user.findUnique({
          where: { id: lockedSession.userId },
          select: { twoFaEnabled: true },
        });
        if (!user) rejectOrganisationCreation();

        const finalized = await finalizeWithTwoFaPolicy(
          {
            userId: lockedSession.userId,
            credentialEpoch: lockedSession.credentialEpoch,
            twoFaEnabled: user.twoFaEnabled,
            config,
            configUrl: lockedSession.configUrl,
            redirectUrl: lockedSession.redirectUrl,
            rememberMe: lockedSession.rememberMe,
            requestAccess: lockedSession.requestAccess,
            state: lockedSession.state,
            authMethod: lockedSession.authMethod,
            codeChallenge: lockedSession.codeChallenge,
            codeChallengeMethod: lockedSession.codeChallengeMethod,
            ip: request.ip ?? null,
            orgId: organisation.id,
            teamId: team.id,
          },
          { policyLockHeld: true, policyPrisma: tx, prisma: tx, teamPrisma: tx },
        );
        return { finalized, userId: lockedSession.userId, authMethod: lockedSession.authMethod };
      });

      if (outcome.finalized.kind === 'twofa') {
        reply
          .status(200)
          .send({ ok: true, twofa_required: true, twofa_token: outcome.finalized.twofa_token });
        return;
      }
      if (outcome.finalized.kind === 'twofa_enroll_required') {
        reply.status(200).send({
          ok: true,
          kind: 'twofa_enroll_required',
          twofa_enroll_required: true,
          ...outcome.finalized.setup,
        });
        return;
      }

      try {
        await recordLoginLog(
          {
            userId: outcome.userId,
            domain: config.domain,
            authMethod: outcome.authMethod,
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
        code:
          outcome.finalized.finalResult.status === 'granted'
            ? outcome.finalized.finalResult.code
            : undefined,
        redirect_to: outcome.finalized.finalResult.redirectTo,
        access_request_status:
          outcome.finalized.finalResult.status === 'requested' ? 'pending' : undefined,
      });
    },
  );
}
