import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { runInTransaction } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { buildWorkspaceChoices } from '../../services/first-login.service.js';
import {
  assertLoginSessionContinuation,
  verifyLoginSession,
} from '../../services/login-session.service.js';
import { consumeLoginSession } from '../../services/login-session-use.service.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import {
  acceptTeamInviteWithinTransaction,
  declineTeamInviteForUser,
} from '../../services/team-invite.service.js';
import { redeemTeamInviteLink } from '../../services/team-invite-link.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/workspace-finalize.service.js';
import { lockAndAssertActiveClientWorkspaceScope } from '../../services/workspace-scope.service.js';
import { AppError } from '../../utils/errors.js';
import { lockAndAssertAuthenticationEpoch } from '../../services/authentication-epoch.service.js';
import { lockProductWorkspacePolicyShared } from '../../services/product-workspace-policy-lock.service.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { selectTeamRateLimiter } from './rate-limit-keys.js';

const BodySchema = z
  .object({
    login_token: z.string().min(1).max(4096),
    teamId: z.string().min(1).max(256).optional(),
    inviteId: z.string().min(1).max(256).optional(),
    // Phase 5 (design §4.7 Task 3): redeem a shareable invite link. Mutually exclusive with
    // teamId/inviteId — the link only completes AFTER this bridge token proves the email was
    // already verified (an invite link never authorizes authentication on its own).
    inviteLinkToken: z.string().min(1).max(4096).optional(),
    action: z.enum(['accept', 'decline']).optional(),
    remember_me: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const provided = [body.teamId, body.inviteId, body.inviteLinkToken].filter(
      (value) => value !== undefined,
    ).length;
    if (provided > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'teamId, inviteId, and inviteLinkToken are mutually exclusive',
      });
    }
  });

const QuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    redirect_url: z.string().min(1).max(2048).optional(),
    code_challenge: z.string().min(1).max(256).optional(),
    code_challenge_method: z.string().min(1).max(32).optional(),
    request_access: z.string().max(16).optional(),
  })
  .strict();

/** Every select-team validation failure is the same generic auth failure — no oracle. */
function rejectSelection(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

/**
 * Phase 3b (design §4.3, §11.5, §8): choose a workspace (or accept/decline a pending invite) for an
 * already-verified user carrying a `login_token` bridge. Validates the bridge token, the selected
 * team's ACTIVE membership and centrally resolved client/product policy (IDOR guard — an
 * ineligible team or one the user isn't an ACTIVE member of is rejected identically to an invalid
 * token), enforces the selected org's 2FA policy, and finalizes with the resolved workspace scope
 * threaded onto the authorization code.
 */
export function registerAuthSelectTeamRoute(app: FastifyInstance): void {
  app.post(
    '/auth/select-team',
    {
      preHandler: [selectTeamRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { login_token, teamId, inviteId, inviteLinkToken, action, remember_me } =
        BodySchema.parse(request.body);
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);

      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

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
        rejectSelection();
      }
      const requestAccess = parseRequestAccessFlag(request_access);
      assertLoginSessionContinuation(session, {
        redirectUrl,
        rememberMe: remember_me,
        requestAccess,
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
      });

      const prisma = request.adminDb;

      // Decline path: no membership change, no finalize — return the refreshed chooser.
      if (inviteId && action === 'decline') {
        const choices = await runInTransaction(prisma, async (tx) => {
          await lockProductWorkspacePolicyShared(tx);
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
          await declineTeamInviteForUser({
            prisma: tx,
            teamInviteId: inviteId,
            userId: lockedSession.userId,
            config,
            now: new Date(),
          });
          return buildWorkspaceChoices({ userId: lockedSession.userId, config }, { prisma: tx });
        });
        reply.status(200).send({ login_token, ...choices });
        return;
      }

      const outcome = await runInTransaction(prisma, async (tx) => {
        await lockProductWorkspacePolicyShared(tx);
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
        // Claim first. A concurrent replay stops at the unique digest before
        // invite audit or access-request email side effects. Any later failure
        // rolls this insert back, so the legitimate user can retry.
        await consumeLoginSession({
          domain: lockedSession.domain,
          jti: lockedSession.jti,
          expiresAtEpochSeconds: lockedSession.expiresAtEpochSeconds,
          prisma: tx,
          now: new Date(),
        });

        let orgId: string | undefined;
        let resolvedTeamId: string | undefined;

        if (inviteLinkToken) {
          // Redemption, finalization, and the one-time capability claim share
          // this transaction; a replay loser cannot retain a membership grant.
          const redeemed = await redeemTeamInviteLink(
            {
              token: inviteLinkToken,
              userId: lockedSession.userId,
              domain: config.domain,
              config,
            },
            { prisma: tx },
          );
          orgId = redeemed.orgId;
          resolvedTeamId = redeemed.teamId;
        } else if (inviteId) {
          const accepted = await acceptTeamInviteWithinTransaction({
            prisma: tx,
            teamInviteId: inviteId,
            userId: lockedSession.userId,
            config,
            now: new Date(),
          });
          orgId = accepted.orgId;
          resolvedTeamId = accepted.teamId;
        } else if (teamId) {
          const team = await tx.team.findFirst({
            // Membership and product eligibility are checked together below. Looking up only the
            // opaque id here avoids duplicating (and drifting from) that central policy.
            where: { id: teamId },
            select: { id: true, orgId: true },
          });
          if (!team) rejectSelection();
          orgId = team.orgId;
          resolvedTeamId = team.id;
        }

        // Every resolved path, including shareable invite-link redemption,
        // must finish with the exact ACTIVE org + team rows locked.
        await lockAndAssertActiveClientWorkspaceScope(
          {
            userId: lockedSession.userId,
            domain: config.domain,
            orgId,
            teamId: resolvedTeamId,
          },
          { crossProductPrisma: tx, policyPrisma: tx, prisma: tx },
        );

        const user = await tx.user.findUnique({
          where: { id: lockedSession.userId },
          select: { twoFaEnabled: true },
        });
        if (!user) rejectSelection();

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
            authMethod: lockedSession.authMethod,
            codeChallenge: lockedSession.codeChallenge,
            codeChallengeMethod: lockedSession.codeChallengeMethod,
            ip: request.ip ?? null,
            orgId,
            teamId: resolvedTeamId,
          },
          { policyLockHeld: true, policyPrisma: tx, prisma: tx, workspacePrisma: tx },
        );
        return {
          finalized,
          userId: lockedSession.userId,
          authMethod: lockedSession.authMethod,
        };
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
          { prisma },
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
