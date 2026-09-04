import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { requireOrgFeaturesEnabled } from '../../middleware/org-features.js';
import { resolveOrgUserClaims } from '../../middleware/org-role-guard.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
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

      // /org/me uses the organisations bootstrap predicate (domain + membership);
      // app.org_id is deliberately left empty here — see row-level-security.md §7.
      request.accessTokenClaims = claims;
      setTenantContextFromRequest(request, { orgId: null, userId: claims.userId });

      const org = await request.withTenantTx(async (tx) => {
        const prisma = asPrismaClient(tx);
        // Prefer the org the token is actually scoped to. A user can hold ACTIVE memberships in
        // several organisations, and "the first active membership on this domain" would answer
        // with a different org than every `/org/organisations/:orgId/**` call the same token can
        // make — the sidebar and the surface it links to would disagree.
        let context = await getUserOrgContext(
          {
            userId: claims.userId,
            domain: normalizedDomain,
            config,
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
              groupsEnabled: config.org_features?.groups_enabled,
            },
            { prisma },
          );
        }
        if (!context) return context;

        // Gap-fix A Task 1 (design §11.4 sidebar contract): appended, additive top-level fields —
        // org_id/org_role/teams/team_roles/groups above are unchanged. Domain-scoped reads share
        // this tenant transaction; policy-authorized cross-domain reads use their existing guarded
        // admin-client path.
        const teamPolicy = await resolveProductTeamPolicy({ domain: normalizedDomain });
        const [teams, pendingInvites] = await Promise.all([
          buildSidebarTeams(
            { userId: claims.userId, domain: normalizedDomain },
            { prisma, policy: teamPolicy },
          ),
          buildSidebarPendingInvites({ userId: claims.userId, domain: normalizedDomain }, { prisma }),
        ]);

        return { ...context, teams, pending_invites: pendingInvites };
      });

      const response: { ok: true; org?: typeof org } = { ok: true };
      if (org) response.org = org;

      reply.status(200).send(response);
    },
  );
}
