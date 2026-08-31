import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import {
  requireOrgBackendOnly,
  requireOrgRole,
  resolveActingUserClaims,
  resolveOrgAccessTokenHeader,
} from '../../middleware/org-role-guard.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  acceptTeamInviteWithinTransaction,
  createMemberInvite,
  createTeamInvites,
  getTeamInvite,
  listTeamInvites,
  resendTeamInvite,
  revokeTeamInvite,
} from '../../services/team-invite.service.js';
import { normalizeDomain } from '../../utils/domain.js';
import { AppError } from '../../utils/errors.js';

import {
  BulkInviteBodySchema,
  MemberInviteBodySchema,
  getInviteIdFromParams,
  getOrgIdFromParams,
  getTeamIdFromParams,
  keyInviteTeamRateLimit,
  orgCaller,
  parseDomainContext,
  parseDomainContextHook,
  requireVerifiedConfig,
  tenantUserId,
} from './team-route.shared.js';

const AcceptTeamInviteBodySchema = z
  .object({
    userId: z.string().trim().min(1),
  })
  .strict();

export function registerTeamInvitationRoutes(app: FastifyInstance): void {
  app.post(
    '/org/organisations/:orgId/teams/:teamId/invitations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        createRateLimiter({
          limit: 20,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyInviteTeamRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      }

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);

      // Dual-mode route (Phase 4 Task 4, design §4.7): presence of the user access token switches
      // this from the trusted backend bulk-invite call (unchanged below) to the permission-gated,
      // single-invite, member-initiated path — same path/method, alongside the backend contract.
      // Same absent-vs-blank rule as `requireOrgRole`: only a genuinely missing
      // header selects the trusted backend bulk-invite path. A present-but-blank
      // header (an anonymous visitor's empty session forwarded by a BFF) is a
      // malformed credential and 401s inside the resolver.
      const accessToken = resolveOrgAccessTokenHeader(request);
      if (accessToken) {
        // Same resolver as `requireOrgRole`, so this member-initiated path accepts
        // exactly the tokens every other `/org/*` route accepts.
        const claims = await resolveActingUserClaims(accessToken);
        if (normalizeDomain(claims.domain) !== domain) {
          throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
        }

        const body = MemberInviteBodySchema.parse(request.body ?? {});
        const actorUserId = claims.userId;

        setTenantContextFromRequest(request, { orgId, userId: actorUserId });
        const result = await request.withTenantTx((tx) =>
          createMemberInvite(
            {
              orgId,
              teamId,
              domain,
              config,
              configUrl,
              actorUserId,
              redirectUrl: body.redirectUrl,
              invite: { email: body.email, name: body.name, teamRole: body.teamRole },
            },
            { prisma: asPrismaClient(tx) },
          ),
        );

        reply.status(200).send(result);
        return;
      }

      const body = BulkInviteBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId });
      const result = await request.withTenantTx((tx) =>
        createTeamInvites(
          {
            orgId,
            teamId,
            domain,
            config,
            configUrl,
            redirectUrl: body.redirectUrl,
            invitedBy: body.invitedBy,
            invites: body.invites,
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );

  app.get(
    '/org/organisations/:orgId/teams/:teamId/invitations',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId });
      const invites = await request.withTenantTx((tx) =>
        listTeamInvites(
          { orgId, teamId, domain },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(invites);
    },
  );

  // Read one invitation by id — the by-id companion to the list above, for a consumer holding an
  // id from a bulk-invite result, the list, or a resend. Same preValidation stack as the list
  // (domain-hash + verified config + org features), so it is backend-mode capable in exactly the
  // same way, and returns exactly the record shape the list's entries carry.
  app.get(
    '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const inviteId = getInviteIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId });
      const invite = await request.withTenantTx((tx) =>
        getTeamInvite(
          { orgId, teamId, inviteId, domain },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(invite);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId/resend',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        createRateLimiter({
          limit: 20,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyInviteTeamRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      }

      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const inviteId = getInviteIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId });
      const invite = await request.withTenantTx((tx) =>
        resendTeamInvite(
          { orgId, teamId, inviteId, domain, config, configUrl },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(invite);
    },
  );

  app.post(
    '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId/accept',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgBackendOnly(),
        createRateLimiter({
          limit: 20,
          windowMs: 60 * 60 * 1000,
          keyBuilder: keyInviteTeamRateLimit,
        }),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const config = requireVerifiedConfig(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const inviteId = getInviteIdFromParams(request.params);
      const body = AcceptTeamInviteBodySchema.parse(request.body ?? {});

      setTenantContextFromRequest(request, { orgId });
      const accepted = await request.withTenantTx(async (tx) => {
        const invite = await tx.teamInvite.findUnique({
          where: { id: inviteId },
          select: {
            id: true,
            orgId: true,
            teamId: true,
            org: { select: { domain: true } },
          },
        });
        if (
          !invite ||
          invite.orgId !== orgId ||
          invite.teamId !== teamId ||
          normalizeDomain(invite.org.domain) !== domain
        ) {
          throw new AppError('BAD_REQUEST', 400);
        }

        return await acceptTeamInviteWithinTransaction({
          prisma: tx,
          teamInviteId: invite.id,
          userId: body.userId,
          config,
          now: new Date(),
        });
      });

      reply.status(200).send({ ok: true, ...accepted });
    },
  );

  // Revoke a pending invitation (sent or awaiting approval). Dual-mode via `requireOrgRole()` —
  // the same absent-vs-blank access-token rule as every other `/org/*` guard: a user token makes
  // it a permission-gated user call (org/team owner/admin or the original inviter, enforced in the
  // service), a genuinely absent header selects backend mode (requires the config's
  // `org_features.backend_org_management` opt-in; audited with `actorUserId: null` + `uoa_actor`).
  app.delete(
    '/org/organisations/:orgId/teams/:teamId/invitations/:inviteId',
    {
      preValidation: [
        requireDomainHashAuthForDomainQuery(),
        configVerifier,
        parseDomainContextHook,
        requireOrgFeatures,
        requireOrgRole(),
      ],
    },
    async (request, reply) => {
      const { domain } = parseDomainContext(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const inviteId = getInviteIdFromParams(request.params);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const result = await request.withTenantTx((tx) =>
        revokeTeamInvite(
          {
            orgId,
            teamId,
            inviteId,
            domain,
            ...orgCaller(request),
            config: requireVerifiedConfig(request),
          },
          { prisma: asPrismaClient(tx) },
        ),
      );

      reply.status(200).send(result);
    },
  );
}
