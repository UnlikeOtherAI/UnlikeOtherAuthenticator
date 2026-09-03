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
import { lockProductTeamPolicyShared } from '../../services/product-team-policy-lock.service.js';
import { addTeamMember } from '../../services/team.service.members.js';
import { createTeam } from '../../services/team.service.teams.js';
import { lockRequiredTeamPlacementUser } from '../../services/user-team-requirement.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/team-finalize.service.js';
import {
  lockAndAssertActiveClientTeamScope,
  lockTeamOrganisationRow,
} from '../../services/team-scope.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { AppError } from '../../utils/errors.js';
import { selectTeamRateLimiter } from './rate-limit-keys.js';

const BodySchema = z
  .object({
    login_token: z.string().min(1).max(4096),
    org_id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(100),
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

function rejectTeamCreation(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

/**
 * Creates a further team (team) inside an organisation the user already belongs to, straight
 * from the SSO chooser, then selects it.
 *
 * The sibling of `/auth/create-organisation`, and deliberately a separate route: that one creates a
 * user's *first* organisation (brief §1718), this one writes into an existing tenant. An org is
 * the level above a team, so the authorization differs — `createTeam` runs
 * `requireTeamManager`, i.e. the acting user must be an ACTIVE **org owner/admin** of `org_id`,
 * and the org must belong to this config's domain. The domain must also opt in with
 * `org_features.allow_user_create_team`; the role check alone is not enough to add a popup-driven
 * write path to a tenant.
 *
 * The security envelope is `/auth/create-organisation`'s, unchanged: the short-lived login capability
 * is verified, re-verified under the epoch lock, and consumed in the same transaction as the team,
 * its creator membership, and the auth continuation — so a replayed token cannot leave a duplicate
 * team behind.
 */
export function registerAuthCreateTeamRoute(app: FastifyInstance): void {
  app.post(
    '/auth/create-team',
    { preHandler: [selectTeamRateLimiter, configVerifier] },
    async (request, reply) => {
      const { login_token, org_id, name, join_policy, remember_me } = BodySchema.parse(
        request.body,
      );
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
        rejectTeamCreation();
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
          !config.org_features.allow_user_create_team
        ) {
          rejectTeamCreation();
        }
        // Serializes concurrent login bridges the same way `/auth/create-organisation` does, so two
        // of them cannot each create a team from the same chooser.
        await lockRequiredTeamPlacementUser(lockedSession.userId, { prisma: tx });

        // Claim before writing. A later failure rolls the claim and the team back together,
        // leaving a legitimate retry possible.
        await consumeLoginSession({
          domain: lockedSession.domain,
          jti: lockedSession.jti,
          expiresAtEpochSeconds: lockedSession.expiresAtEpochSeconds,
          prisma: tx,
          now: new Date(),
        });

        // Take the org row before writing into it, which does two things. It puts this route on
        // the same org → team → membership lock order `deleteTeam` uses, so a concurrent delete
        // and create on one org queue instead of risking a cycle. And it serializes the
        // `max_teams_per_org` count-then-insert inside `createTeam`, which is otherwise a
        // read-outside-any-lock: two admins of the same org could each read `count = cap - 1` and
        // both insert. A missing row means the org is gone; fold it into the generic failure
        // rather than leaking which of "no such org" or "not yours" it was.
        if (!(await lockTeamOrganisationRow(org_id, { prisma: tx }))) {
          rejectTeamCreation();
        }

        // `createTeam` is the authorization boundary: it resolves the org against THIS config's
        // domain and runs `requireTeamManager` on the acting user, so a login token for one domain
        // cannot reach an org on another, and a plain member cannot create at all.
        const team = await createTeam(
          {
            orgId: org_id,
            domain: config.domain,
            name,
            joinPolicy: join_policy,
            actorUserId: lockedSession.userId,
            config,
          },
          { prisma: tx, auditPrisma: tx },
        );

        // The creator has to be IN the team they just made: the chooser only lists ACTIVE
        // memberships, and the finalize below binds a team this user must belong to.
        await addTeamMember(
          {
            orgId: org_id,
            teamId: team.id,
            domain: config.domain,
            userId: lockedSession.userId,
            teamRole: 'admin',
            actorUserId: lockedSession.userId,
            config,
          },
          { prisma: tx, auditPrisma: tx },
        );

        await lockAndAssertActiveClientTeamScope(
          {
            userId: lockedSession.userId,
            domain: config.domain,
            orgId: org_id,
            teamId: team.id,
          },
          { crossProductPrisma: tx, policyPrisma: tx, prisma: tx },
        );
        const user = await tx.user.findUnique({
          where: { id: lockedSession.userId },
          select: { twoFaEnabled: true },
        });
        if (!user) rejectTeamCreation();

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
            orgId: org_id,
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
