import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import {
  issueAgentConnectionGrant,
  renewAgentConnectionGrant,
  revokeAgentConnectionGrant,
} from '../../services/agent-connection-grant.service.js';
import { AppError } from '../../utils/errors.js';
import { agentConnectionGrantRateLimiter } from './rate-limit-keys.js';

const Uuid = z.string().uuid();
const IssueBody = z.object({
  request_id: Uuid,
  all_teams: z.boolean().optional(),
  connection_id: z.string().min(1).max(160),
  product: z.string().min(1).max(100),
  resource: z.string().min(1).max(2048),
  subject_token: z.string().min(1).max(16 * 1024),
  subject_token_type: z.literal('urn:ietf:params:oauth:token-type:jwt'),
}).strict();
const RenewBody = z.object({
  request_id: Uuid,
  touch: z.boolean(),
  target: z.object({ org_id: z.string().min(1).max(256), team_id: z.string().min(1).max(256) }).strict().optional(),
  connection_only: z.boolean().optional(),
  list_teams: z.boolean().optional(),
  resource: z.string().min(1).max(2048).optional(),
  scope: z.string().min(1).max(200).optional(),
}).strict();
const RevokeBody = z.object({ request_id: Uuid }).strict();
const GrantParams = z.object({ grantHandle: Uuid }).strict();

function appBinding(request: FastifyRequest) {
  const domain = request.config?.domain;
  const clientDomainId = request.domainAuthClientDomainId;
  if (!domain || !clientDomainId) throw new AppError('UNAUTHORIZED', 401);
  return { sourceDomain: domain, clientDomainId };
}

function config(request: FastifyRequest) {
  if (!request.config) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
  return request.config;
}

/** Backend-only grants for programs a person connected to a product (docs: GET /llm, "Agent connection grants"). */
export function registerAgentConnectionGrantRoutes(app: FastifyInstance): void {
  const preHandler = [configVerifier, requireDomainHashAuth, agentConnectionGrantRateLimiter];

  app.post('/auth/agent-grants', { preHandler }, async (request, reply) => {
    const body = IssueBody.parse(request.body);
    if (!request.configJwt) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
    const result = await issueAgentConnectionGrant({
      ...appBinding(request), configJwt: request.configJwt, config: config(request),
      requestId: body.request_id, connectionId: body.connection_id, product: body.product, allTeams: body.all_teams,
      resource: body.resource, subjectToken: body.subject_token,
    }, { prisma: request.adminDb });
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    reply.code(result.created ? 201 : 200);
    return { all_teams: result.allTeams, grant_handle: result.grantHandle, idle_expires_at: result.idleExpiresAt,
      expires_at: result.expiresAt };
  });

  app.post('/auth/agent-grants/:grantHandle/renew', { preHandler }, async (request, reply) => {
    const body = RenewBody.parse(request.body);
    const { grantHandle } = GrantParams.parse(request.params);
    const result = await renewAgentConnectionGrant({
      grantHandle, ...appBinding(request), config: config(request), requestId: body.request_id,
      touch: body.touch, target: body.target, listTeams: body.list_teams, connectionOnly: body.connection_only, resource: body.resource, scope: body.scope,
    }, { prisma: request.adminDb });
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    return {
      idle_expires_at: result.idleExpiresAt, expires_at: result.expiresAt, org: result.org, ...(result.teams ? { teams: result.teams } : {}),
      ...(result.resourceToken ? { access_token: result.resourceToken.accessToken, token_type: 'Bearer',
        expires_in: result.resourceToken.expiresIn, resource: result.resourceToken.resource,
        scope: result.resourceToken.scope } : {}),
    };
  });

  app.post('/auth/agent-grants/:grantHandle/revoke', { preHandler }, async (request, reply) => {
    const body = RevokeBody.parse(request.body);
    const { grantHandle } = GrantParams.parse(request.params);
    const result = await revokeAgentConnectionGrant({ grantHandle, ...appBinding(request),
      requestId: body.request_id }, { prisma: request.adminDb });
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    return result;
  });
}
