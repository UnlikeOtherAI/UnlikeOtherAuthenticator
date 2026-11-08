import type { EndpointSchema } from './schema.js';

export const publicTeamLookupEndpoint: EndpointSchema = {
  method: 'POST',
  path: '/public/teams/lookup',
  description: 'Display names, slugs and image URL for exact UOA team ids, with no credential',
  auth: 'none (public)',
  body: { teamIds: 'array of 0–50 team id strings (each 1–64 characters); duplicates are answered once' },
  response: {
    teams: 'array, in request order, of { teamId, teamName, teamSlug, orgId, orgName, orgSlug, avatarUrl }',
    'teams[].avatarUrl': 'the public /teams/:teamId/avatar?v=<version> image URL; render it exactly as given',
  },
  notes: 'A team id is not a secret: holding one is enough to read its display fields. '
    + 'Unknown ids, and teams whose team or organisation is not ACTIVE, are omitted without an error. '
    + 'Nothing about members, roles, domains, email policies or settings is returned, and only the ids asked for are read. '
    + 'Rate-limited to 1,200 requests per minute per IP plus a global 6,000 per minute per instance (429 RATE_LIMITED); '
    + 'sized for a product server batching its teams, not for end-user devices. Responses are no-store.',
};

export const publicTeamLookupMarkdown = `## Public team display lookup
POST /public/teams/lookup needs no credential. Send {"teamIds":["<UOA team id>", …]} with up to
50 ids and receive {"teams":[{teamId, teamName, teamSlug, orgId, orgName, orgSlug, avatarUrl}]}
in request order. A team id is not a secret: these display fields are all it returns. Unknown ids
and teams whose team or organisation is not ACTIVE are omitted, never reported as errors, so treat
a missing entry as "no name available" and keep any label you already show. avatarUrl is the same
public /teams/:teamId/avatar URL GET /org/me uses. The route is for a product server batching all
of one request's teams in one call: 1,200 requests per minute per IP plus a global ceiling,
answering 429 RATE_LIMITED beyond that. Do not call it from end-user devices, and never use it as
an authority — membership and access still come from /org/* and the token claims.
`;
