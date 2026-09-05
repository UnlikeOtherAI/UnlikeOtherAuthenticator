import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import {
  checkOrgSlugAvailability,
  checkTeamSlugAvailability,
  resolveTeamHostname,
} from '../../services/team-hostname.service.js';

/**
 * `/domain/teams/resolve` and `/domain/slug-available` — the two reads a
 * product needs to serve tenant hostnames.
 *
 * Domain-hash bearer only, and that is the whole reason these are not `/org/*`
 * routes: resolving a hostname happens *before* anyone has an active team, so
 * there is no session to assert a subject from. A product asks "which tenant is
 * this host?" while rendering a cold page, then runs its own team-switch grant
 * with the ids it gets back. The answer is scoped to the caller's own client
 * domain, so a product can only ever resolve its own tenants.
 */

const ResolveQuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    org: z.string().trim().min(1).max(63),
    team: z.string().trim().min(1).max(63),
  })
  .strict();

const AvailabilityQuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    slug: z.string().trim().min(1).max(63),
    scope: z.enum(['organisation', 'team']),
    // Required for scope=team: availability is per organisation, never global.
    org_id: z.string().trim().min(1).optional(),
    // Product hostnames the caller wants treated as reserved on top of the
    // base list, so a product's own `api`/`app` labels cannot be claimed.
    reserved: z.string().trim().max(2048).optional(),
  })
  .strict();

const parseReserved = (value?: string): string[] | undefined =>
  value
    ?.split(',')
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);

export function registerDomainTeamHostnameRoutes(app: FastifyInstance): void {
  app.get(
    '/domain/teams/resolve',
    { preHandler: [requireDomainHashAuthForDomainQuery] },
    async (request, reply) => {
      const { domain, org, team } = ResolveQuerySchema.parse(request.query);

      const resolved = await resolveTeamHostname({ domain, orgSlug: org, teamSlug: team });
      if (!resolved) {
        // The generic 404 every /domain/* miss answers: an unknown organisation
        // and a known organisation with an unknown team are the same reply, so
        // the shape of a tenant's team list is not readable from outside it.
        reply.status(404).send({ ok: false, error: 'NOT_FOUND' });
        return;
      }

      reply.status(200).send({
        ok: true,
        org_id: resolved.orgId,
        org_name: resolved.orgName,
        org_slug: resolved.orgSlug,
        team_id: resolved.teamId,
        team_name: resolved.teamName,
        team_slug: resolved.teamSlug,
      });
    },
  );

  app.get(
    '/domain/slug-available',
    { preHandler: [requireDomainHashAuthForDomainQuery] },
    async (request, reply) => {
      const query = AvailabilityQuerySchema.parse(request.query);
      const reserved = parseReserved(query.reserved);

      if (query.scope === 'team') {
        if (!query.org_id) {
          reply.status(400).send({ ok: false, error: 'ORG_ID_REQUIRED' });
          return;
        }

        const result = await checkTeamSlugAvailability({
          orgId: query.org_id,
          slug: query.slug,
          reservedLabels: reserved,
        });
        reply.status(200).send({ ok: true, ...result });
        return;
      }

      const result = await checkOrgSlugAvailability({
        domain: query.domain,
        slug: query.slug,
        reservedLabels: reserved,
      });
      reply.status(200).send({ ok: true, ...result });
    },
  );
}
