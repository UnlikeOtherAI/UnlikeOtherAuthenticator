import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { requireOrgFeaturesEnabled } from '../../middleware/org-features.js';
import { resolveActingUserClaims } from '../../middleware/org-role-guard.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import {
  getActiveClientOrgContext,
  getUserOrgContext,
} from '../../services/org-context.service.js';
import {
  buildSidebarPendingInvites,
  buildSidebarWorkspaces,
} from '../../services/workspace-directory.service.js';
import { resolveProductWorkspacePolicy } from '../../services/product-workspace-policy.service.js';
import { AppError } from '../../utils/errors.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    config_url: z.string().trim().min(1),
  })
  .strict();

function parseBearerOrRawToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('bearer ')) return trimmed;

  const token = trimmed.slice('bearer '.length).trim();
  return token || null;
}

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

      const token = parseBearerOrRawToken(request.headers['x-uoa-access-token']);
      if (!token) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
      }

      // Same resolver as `requireOrgRole`, so `/org/me` accepts exactly the tokens
      // every other `/org/*` route accepts.
      const claims = await resolveActingUserClaims(token);
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
        let context = await getUserOrgContext(
          { userId: claims.userId, domain: normalizedDomain, config },
          { prisma },
        );

        // A recognized product can issue an exact workspace-scoped token for an organisation
        // owned by another product domain. Keep the legacy singular org block complete by
        // resolving that selected organisation live through the same server-owned product-policy
        // gate used at token issuance; never synthesize an org from an arbitrary directory row.
        if (!context && claims.active) {
          context = await getActiveClientOrgContext(
            {
              userId: claims.userId,
              domain: normalizedDomain,
              orgId: claims.active.orgId,
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
        const workspacePolicy = await resolveProductWorkspacePolicy({ domain: normalizedDomain });
        const [workspaces, pendingInvites] = await Promise.all([
          buildSidebarWorkspaces(
            { userId: claims.userId, domain: normalizedDomain },
            { prisma, policy: workspacePolicy },
          ),
          buildSidebarPendingInvites({ userId: claims.userId, domain: normalizedDomain }, { prisma }),
        ]);

        return { ...context, workspaces, pending_invites: pendingInvites };
      });

      const response: { ok: true; org?: typeof org } = { ok: true };
      if (org) response.org = org;

      reply.status(200).send(response);
    },
  );
}
