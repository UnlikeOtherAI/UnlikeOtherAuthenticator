import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { AppError } from '../../utils/errors.js';
import { tokenExchangePreAuthRateLimiter } from './rate-limit-keys.js';
import { tokenPairResponse } from './token-response.js';
import {
  cancelDeviceLogin, claimDeviceLogin, claimDeviceStatus, completeDeviceLogin,
  consumeDeviceClaimBudget, decideDeviceLogin, issueDeviceLogin, sourceDeviceStatus,
  type DeviceLoginContext,
} from '../../services/device-login.service.js';

const source = z.string().min(1).max(4096);
const id = z.string().min(1).max(100);
const verifier = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const code = z.string().regex(/^\d{8}$/);
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const bodies = {
  issue: z.object({ refresh_token: source, previous_grant_id: id.optional() }).strict(),
  claim: z.object({ code, code_challenge: challenge }).strict(),
  'source-status': z.object({ refresh_token: source, grant_id: id }).strict(),
  approve: z.object({ refresh_token: source, grant_id: id, claim_id: id }).strict(),
  deny: z.object({ refresh_token: source, grant_id: id, claim_id: id }).strict(),
  cancel: z.object({ refresh_token: source, grant_id: id }).strict(),
  'claim-status': z.object({ claim_id: id, code_verifier: verifier }).strict(),
  complete: z.object({ claim_id: id, code_verifier: verifier }).strict(),
};

export function registerDeviceLoginRoutes(app: FastifyInstance): void {
  for (const action of Object.keys(bodies) as Array<keyof typeof bodies>) {
    app.post('/auth/device-login/' + action, {
      preHandler: [tokenExchangePreAuthRateLimiter, configVerifier, requireDomainHashAuth],
    }, async (request, reply) => {
      const { config, configUrl, domainAuthClientId: clientId, domainAuthClientDomainId: clientDomainId } = request;
      if (!config || !configUrl || !clientId || !clientDomainId) throw new AppError('UNAUTHORIZED', 401);
      const context: DeviceLoginContext = { config, configUrl, clientId, clientDomainId };
      const db = { prisma: request.adminDb };
      reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
      // Parse first; all claim guesses consume durable, shared counters, including misses.
      switch (action) {
        case 'issue': {
          const body = bodies.issue.parse(request.body);
          return issueDeviceLogin(context, body.refresh_token, body.previous_grant_id, db);
        }
        case 'claim': {
          const body = bodies.claim.parse(request.body);
          const requester = request.headers['x-uoa-device-requester'];
          if (typeof requester !== 'string' || !/^[a-f0-9]{64}$/.test(requester)) {
            throw new AppError('UNAUTHORIZED', 401);
          }
          await consumeDeviceClaimBudget(context, requester, db);
          return claimDeviceLogin(context, body.code, body.code_challenge, db);
        }
        case 'source-status': {
          const body = bodies['source-status'].parse(request.body);
          return sourceDeviceStatus(context, body.refresh_token, body.grant_id, db);
        }
        case 'approve': {
          const body = bodies.approve.parse(request.body);
          return decideDeviceLogin(context, body.refresh_token, body.grant_id, body.claim_id, true, db);
        }
        case 'deny': {
          const body = bodies.deny.parse(request.body);
          return decideDeviceLogin(context, body.refresh_token, body.grant_id, body.claim_id, false, db);
        }
        case 'cancel': {
          const body = bodies.cancel.parse(request.body);
          return cancelDeviceLogin(context, body.refresh_token, body.grant_id, db);
        }
        case 'claim-status': {
          const body = bodies['claim-status'].parse(request.body);
          return claimDeviceStatus(context, body.claim_id, body.code_verifier, db);
        }
        case 'complete': {
          const body = bodies.complete.parse(request.body);
          const pair = await completeDeviceLogin(context, body.claim_id, body.code_verifier, db);
          return tokenPairResponse(pair);
        }
      }
    });
  }
}
