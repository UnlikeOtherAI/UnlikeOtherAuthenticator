import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getEnv } from '../../config/env.js';
import { isPlatformSuperuser } from '../../services/domain-role.service.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { requireOrgFeaturesEnabled } from '../../middleware/org-features.js';
import { resolveOrgUserClaims } from '../../middleware/org-role-guard.js';
import { runWithRequestAdminTransaction, setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  getActiveClientOrgContext,
  getUserOrgContext,
} from '../../services/org-context.service.js';
import {
  buildSidebarPendingInvites,
  buildSidebarTeams,
} from '../../services/team-directory.service.js';
import { resolveProductTeamPolicy } from '../../services/product-team-policy.service.js';
import { AppError } from '../../utils/errors.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { memberAvatarImageUrl } from '../../services/organisation.service.base.js';
import { validateSessionAssurance } from '../../services/session-assurance.service.js';
import { assertTenantEffectAuthority } from '../../services/tenant-effect-authority.service.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    config_url: z.string().trim().min(1),
  })
  .strict();

export function registerOrgMeRoute(app: FastifyInstance): void {
  app.get(
    '/org/me',
    {
      preHandler: [requireDomainHashAuthForDomainQuery, configVerifier, requireOrgFeaturesEnabled],
    },
    async (request, reply) => {
      const { domain } = QuerySchema.parse(request.query);
      const normalizedDomain = normalizeDomain(domain);
      assertVerifiedDomainMatchesQuery(request, normalizedDomain);

      // Same resolver as every user-mode `/org/*` route.  In particular a
      // product can use its one-minute subject assertion to read current role
      // context without retaining a UOA user token; the assertion path
      // re-resolves its exact ACTIVE org/team membership before returning.
      const claims = await resolveOrgUserClaims(request);
      if (normalizeDomain(claims.domain) !== normalizedDomain) {
        throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
      }

      const config = request.config;
      if (!config) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      }

      request.accessTokenClaims = claims;
      setTenantContextFromRequest(request, { orgId: null, userId: claims.userId });

      // This bootstrap projection spans tenant membership, platform roles, product policy
      // and the caller's own invitations. Pin authority and every read on ONE admin connection:
      // an app transaction holding the shared epoch while requesting a second pool can cycle
      // with admin writers waiting for that epoch. See row-level-security.md §10.15.
      const { org, self, systemAdmin } = await runWithRequestAdminTransaction(request, async (prisma) => {
        if (getEnv().DATABASE_URL) {
          const context = request.tenantContext;
          if (!context) throw new Error('Organisation authority read requires tenantContext');
          await assertTenantEffectAuthority(request, context, prisma, prisma, { userEpochLock: 'shared' });
          // A proof checked before acquiring this connection may have been revoked while queued.
          if (claims.assuranceId) await validateSessionAssurance({
            id: claims.assuranceId, userId: claims.userId, credentialEpoch: claims.tokenVersion,
            clientDomain: normalizedDomain, orgId: claims.active?.orgId ?? claims.org?.org_id,
            teamId: claims.active?.teamId,
          }, prisma);
        }
        const systemAdmin = Boolean(getEnv().DATABASE_URL) && await isPlatformSuperuser({
          userId: claims.userId,
          prisma,
        });
        // Prefer the org the token is actually scoped to. A user can hold ACTIVE memberships in
        // several organisations, and "the first active membership on this domain" would answer
        // with a different org than every `/org/organisations/:orgId/**` call the same token can
        // make — the sidebar and the surface it links to would disagree.
        let context = await getUserOrgContext(
          {
            userId: claims.userId,
            domain: normalizedDomain,
            config,
            assuranceId: claims.assuranceId,
            ...(claims.org?.org_id ? { orgId: claims.org.org_id } : {}),
          },
          { prisma },
        );

        // A recognized product can issue an exact team-scoped token for an organisation
        // owned by another product domain. Keep the legacy singular org block complete by
        // resolving that selected organisation live through the same server-owned product-policy
        // gate used at token issuance; never synthesize an org from an arbitrary directory row.
        const selectedOrgId = claims.active?.orgId ?? claims.org?.org_id;
        if (!context && selectedOrgId) {
          context = await getActiveClientOrgContext(
            {
              userId: claims.userId,
              domain: normalizedDomain,
              orgId: selectedOrgId,
              assuranceId: claims.assuranceId,
              groupsEnabled: config.org_features?.groups_enabled,
            },
            { prisma, policyPrisma: prisma, crossProductPrisma: prisma },
          );
        }

        const teamPolicy = context ? await resolveProductTeamPolicy({ domain: normalizedDomain }, { prisma }) : undefined;
        const [teamDirectory, pendingInvites] = context ? await Promise.all([
          buildSidebarTeams(
            { userId: claims.userId, domain: normalizedDomain },
            { prisma, crossProductPrisma: prisma, policy: teamPolicy },
          ),
          buildSidebarPendingInvites(
            { userId: claims.userId, domain: normalizedDomain },
            { prisma, invitePrisma: prisma, policy: teamPolicy },
          ),
        ]) : [[], []];

        const self = await prisma.user.findUniqueOrThrow({ where: { id: claims.userId },
          select: { id: true, name: true, email: true, lifecycleStatus: true } });
        if (self.lifecycleStatus !== 'ACTIVE') throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
        return { org: context ? { ...context, team_directory: teamDirectory, pending_invites: pendingInvites } : null,
          self, systemAdmin };
      });
      const response: { ok: true; system_admin: boolean; org?: typeof org; self_identity: {
        subject: string; display_name: string | null; email: string | null; avatar_image_url: string;
      } } = {
        ok: true,
        system_admin: systemAdmin,
        self_identity: { subject: self.id, display_name: self.name, email: self.email,
          avatar_image_url: memberAvatarImageUrl(normalizedDomain, self.id) },
      };
      if (org) response.org = org;

      reply.header('Cache-Control', 'private, no-store').status(200).send(response);
    },
  );
}
