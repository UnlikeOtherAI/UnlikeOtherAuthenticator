import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import {
  issueSalesResearchJobGrant,
  renewSalesResearchJobGrant,
  revokeSalesResearchJobGrant,
} from '../../services/sales-research-job-grant.service.js';
import { AppError } from '../../utils/errors.js';
import { confidentialJobGrantRateLimiter } from './rate-limit-keys.js';

const Uuid = z.string().uuid();
const JobId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
const IssueBody = z.object({
  request_id: Uuid,
  subject_token: z.string().min(1).max(16 * 1024),
  subject_token_type: z.literal('urn:ietf:params:oauth:token-type:jwt'),
}).strict();
const BoundJobBody = z.object({ request_id: Uuid, job_id: JobId }).strict();
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

function grantHandle(request: FastifyRequest): string {
  return GrantParams.parse(request.params).grantHandle;
}

export function registerSalesResearchJobGrantRoutes(app: FastifyInstance): void {
  const preHandler = [configVerifier, requireDomainHashAuth, confidentialJobGrantRateLimiter];

  app.post('/auth/job-grants', { preHandler }, async (request, reply) => {
    const body = IssueBody.parse(request.body);
    if (!request.configJwt) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
    const result = await issueSalesResearchJobGrant({
      ...appBinding(request),
      configJwt: request.configJwt,
      config: config(request),
      requestId: body.request_id,
      subjectToken: body.subject_token,
    }, { prisma: request.adminDb });
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    reply.code(result.created ? 201 : 200);
    return { grant_handle: result.grantHandle, expires_at: result.expiresAt };
  });

  app.post('/auth/job-grants/:grantHandle/renew', { preHandler }, async (request, reply) => {
    const body = BoundJobBody.parse(request.body);
    const handle = grantHandle(request);
    const { sourceDomain, clientDomainId } = appBinding(request);
    const result = await renewSalesResearchJobGrant({
      grantHandle: handle, clientDomainId, sourceDomain, config: config(request),
      requestId: body.request_id, jobId: body.job_id,
    }, { prisma: request.adminDb });
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    return { access_token: result.accessToken, token_type: 'Bearer',
      expires_in: result.expiresIn, scope: 'ai.invoke' };
  });

  app.post('/auth/job-grants/:grantHandle/revoke', { preHandler }, async (request, reply) => {
    const body = BoundJobBody.parse(request.body);
    const handle = grantHandle(request);
    const { sourceDomain, clientDomainId } = appBinding(request);
    const result = await revokeSalesResearchJobGrant({
      grantHandle: handle, clientDomainId, sourceDomain,
      requestId: body.request_id, jobId: body.job_id,
    }, { prisma: request.adminDb });
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    return result;
  });
}
