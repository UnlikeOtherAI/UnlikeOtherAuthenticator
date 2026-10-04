import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  issueJobComputeRenewal, recoverJobComputeRenewal,
  renewJobComputeAuthority, revokeJobComputeRenewal,
  revokeJobComputeRenewalFromOrigin,
} from '../../services/billing-job-compute-renewal.service.js';
import { AppError } from '../../utils/errors.js';

const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const Identity = z.object({
  origin_invocation_id: Identifier,
  ledger_job_id: Identifier,
  water_job_id: z.string().uuid(),
  scope_turn_id: Identifier.nullable(),
  purpose: z.enum(['research_compute', 'scope_turn_compute']),
}).strict();
const Issue = Identity.extend({
  issue_key: z.string().regex(/^[a-f0-9]{64}$/),
  secret: z.string().regex(/^uoa_job_[A-Za-z0-9_-]{43}$/),
}).strict();
const OriginRevoke = Identity.extend({ issue_key: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Recipient = Identity.extend({
  secret: z.string().regex(/^uoa_job_[A-Za-z0-9_-]{43}$/),
}).strict();
const Params = z.object({ grantId: z.string().uuid() }).strict();

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 401, 'JOB_COMPUTE_CREDENTIAL_REQUIRED');
  }
  return header.slice(7);
}

function identity(body: z.infer<typeof Identity>) {
  return { originInvocationId: body.origin_invocation_id,
    ledgerJobId: body.ledger_job_id, waterJobId: body.water_job_id,
    scopeTurnId: body.scope_turn_id, purpose: body.purpose };
}

export function registerJobComputeRenewalRoutes(app: FastifyInstance): void {
  app.post('/billing/v1/ledger/job-compute-renewals', async (request, reply) => {
    const body = Issue.parse(request.body);
    const delegation = request.headers['x-uoa-delegation'];
    if (typeof delegation !== 'string' || !delegation) {
      throw new AppError('UNAUTHORIZED', 401, 'UOA_DELEGATION_REQUIRED');
    }
    const result = await issueJobComputeRenewal({ runtimeSecret: bearer(request),
      delegation, input: { ...identity(body), issueKey: body.issue_key,
        secret: body.secret } });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
  app.post('/billing/v1/ledger/job-compute-renewals/recover', async (request, reply) => {
    const body = Issue.parse(request.body);
    const result = await recoverJobComputeRenewal({ runtimeSecret: bearer(request),
      input: { ...identity(body), issueKey: body.issue_key, secret: body.secret } });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
  app.post('/billing/v1/ledger/job-compute-renewals/:grantId/revoke', async (request, reply) => {
    const body = OriginRevoke.parse(request.body);
    const { grantId } = Params.parse(request.params);
    const result = await revokeJobComputeRenewalFromOrigin({
      runtimeSecret: bearer(request), grantId, issueKey: body.issue_key,
      identity: identity(body),
    });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
  app.post('/billing/v1/job-compute-renewals/:grantId/renew', async (request, reply) => {
    const body = Recipient.parse(request.body);
    const { grantId } = Params.parse(request.params);
    const result = await renewJobComputeAuthority({ appKey: bearer(request),
      secret: body.secret, grantId, identity: identity(body) });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
  app.post('/billing/v1/job-compute-renewals/:grantId/revoke', async (request, reply) => {
    const body = Recipient.parse(request.body);
    const { grantId } = Params.parse(request.params);
    const result = await revokeJobComputeRenewal({ appKey: bearer(request),
      secret: body.secret, grantId, identity: identity(body) });
    reply.header('Cache-Control', 'no-store');
    return result;
  });
}
