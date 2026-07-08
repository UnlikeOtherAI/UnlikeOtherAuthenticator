import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { runInTransaction } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { buildWorkspaceChoices } from '../../services/first-login.service.js';
import { verifyLoginSession } from '../../services/login-session.service.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { selectRedirectUrl } from '../../services/authorization-code.service.js';
import {
  acceptTeamInviteWithinTransaction,
  declineTeamInviteForUser,
} from '../../services/team-invite.service.js';
import { redeemTeamInviteLink } from '../../services/team-invite-link.service.js';
import { finalizeWithTwoFaPolicy } from '../../services/workspace-finalize.service.js';
import { AppError } from '../../utils/errors.js';
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
 * team's ACTIVE membership and domain (IDOR guard — a team on another domain, or one the user isn't
 * an ACTIVE member of, is rejected identically to an invalid token), enforces the selected org's 2FA
 * policy, and finalizes with the resolved workspace scope threaded onto the authorization code.
 */
export function registerAuthSelectTeamRoute(app: FastifyInstance): void {
  app.post(
    '/auth/select-team',
    {
      preHandler: [selectTeamRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { login_token, teamId, inviteId, inviteLinkToken, action, remember_me } = BodySchema.parse(
        request.body,
      );
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

      const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
      const session = await verifyLoginSession({
        token: login_token,
        domain: config.domain,
        sharedSecret: SHARED_SECRET,
        audience: LOGIN_SESSION_AUDIENCE,
      });
      const userId = session.userId;
      const now = new Date();
      const prisma = request.adminDb;

      // Decline path: no membership change, no finalize — return the refreshed chooser.
      if (inviteId && action === 'decline') {
        await runInTransaction(prisma, (tx) =>
          declineTeamInviteForUser({ prisma: tx, teamInviteId: inviteId, userId, config, now }),
        );
        const choices = await buildWorkspaceChoices({ userId, config }, { prisma });
        reply.status(200).send({ login_token, ...choices });
        return;
      }

      let orgId: string | undefined;
      let resolvedTeamId: string | undefined;

      if (inviteLinkToken) {
        // Phase 5 (design §4.7 Task 3): the security-correct join — the link only completes AFTER
        // the bridge token above proves the email was verified. Every validation failure inside
        // redeemTeamInviteLink (revoked/expired/over-cap/HIDDEN/cross-domain/unknown) throws the
        // same generic error, so no oracle leaks which condition failed.
        const redeemed = await redeemTeamInviteLink(
          { token: inviteLinkToken, userId, domain: config.domain, config },
          { prisma },
        );
        orgId = redeemed.orgId;
        resolvedTeamId = redeemed.teamId;
      } else if (inviteId) {
        // IDOR guard: acceptTeamInviteWithinTransaction re-validates the invite's org domain and
        // the invitee email against the verified user before creating any membership.
        const invite = await prisma.teamInvite.findUnique({
          where: { id: inviteId },
          select: { orgId: true, teamId: true },
        });
        if (!invite) rejectSelection();

        await runInTransaction(prisma, (tx) =>
          acceptTeamInviteWithinTransaction({
            prisma: tx,
            teamInviteId: inviteId,
            userId,
            config,
            now,
          }),
        );
        orgId = invite.orgId;
        resolvedTeamId = invite.teamId;
      } else if (teamId) {
        // IDOR guard: the team must belong to an org on THIS config's domain, and the verified
        // user must hold an ACTIVE (not deactivated/removed) membership on it.
        const team = await prisma.team.findFirst({
          where: { id: teamId, org: { domain: config.domain } },
          select: { id: true, orgId: true },
        });
        if (!team) rejectSelection();

        const membership = await prisma.teamMember.findFirst({
          where: { teamId: team.id, userId, status: 'ACTIVE' },
          select: { id: true },
        });
        if (!membership) rejectSelection();

        orgId = team.orgId;
        resolvedTeamId = team.id;
      }

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });
      const rememberMe = remember_me ?? config.session?.remember_me_default ?? true;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { twoFaEnabled: true },
      });
      if (!user) rejectSelection();

      const outcome = await finalizeWithTwoFaPolicy(
        {
          userId,
          twoFaEnabled: user.twoFaEnabled,
          config,
          configUrl,
          redirectUrl,
          rememberMe,
          requestAccess: parseRequestAccessFlag(request_access),
          authMethod: 'workspace_select',
          codeChallenge: pkce.codeChallenge,
          codeChallengeMethod: pkce.codeChallengeMethod,
          ip: request.ip ?? null,
          orgId,
          teamId: resolvedTeamId,
        },
        { prisma },
      );

      if (outcome.kind === 'twofa') {
        reply.status(200).send({ ok: true, twofa_required: true, twofa_token: outcome.twofa_token });
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
            authMethod: 'workspace_select',
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
        code: outcome.finalResult.status === 'granted' ? outcome.finalResult.code : undefined,
        redirect_to: outcome.finalResult.redirectTo,
        access_request_status: outcome.finalResult.status === 'requested' ? 'pending' : undefined,
      });
    },
  );
}
