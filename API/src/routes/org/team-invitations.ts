import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import requireDomainHashAuthForDomainQuery from '../../middleware/domain-hash-auth.js';
import { requireOrgFeatures } from '../../middleware/org-features.js';
import {
  requireOrgBackendOnly,
  requireOrgRole,
} from '../../middleware/org-role-guard.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  acceptTeamInviteWithinTransaction,
  createMemberInvite,
  createTeamInvites,
  getTeamInvite,
  listPendingInvitations,
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
  parseTeamPendingInvitationsQuery,
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
        requireOrgRole(),
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

      // `requireOrgRole` selects the caller once: either a user credential
      // (access token or subject assertion) makes this a permission-gated,
      // single-invite call, or the proven domain backend keeps the existing
      // bulk contract. A subject assertion is intentionally a user credential,
      // never an accidental fall-through to backend authority.
      const caller = orgCaller(request);
      if ('actorUserId' in caller) {
        const body = MemberInviteBodySchema.parse(request.body ?? {});

        setTenantContextFromRequest(request, { orgId, userId: caller.actorUserId });
        const result = await request.withTenantTx((tx) =>
          createMemberInvite(
            {
              orgId,
              teamId,
              domain,
              config,
              configUrl,
              actorUserId: caller.actorUserId,
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
    '/org/organisations/:orgId/teams/:teamId/member-invitations',
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
      const { domain, limit, cursor, direction } = parseTeamPendingInvitationsQuery(request);
      const orgId = getOrgIdFromParams(request.params);
      const teamId = getTeamIdFromParams(request.params);
      const config = requireVerifiedConfig(request);

      setTenantContextFromRequest(request, { orgId, userId: tenantUserId(request) });
      const result = await request.withTenantTx((tx) =>
        listPendingInvitations(
          { orgId, teamId, domain, ...orgCaller(request), config, limit, cursor, direction },
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
