import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPublicBaseUrl } from '../config/env.js';
import { configVerifier } from '../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../middleware/domain-hash-auth.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { machineBoundary, machineTransaction } from '../services/machine-authority.service.js';
import { MachineBinding, MachineChallengeInput, MachineDecisionResponse, MachineOperationWithProof, MachineProof,
  MachineRecoveryInput, MachineRecoveryResponse, MachineRequestInput, MachineTranscriptFields, MachineUnavailableOutcome,
  MACHINE_CAPABILITY, machineCapabilities } from '../services/machine-contract.js';
import { machineMac, machineRefused } from '../services/machine-crypto.js';
import { createMachineRequest, machineRequestResult, proveMachineRequest } from '../services/machine-request.service.js';
import { createMachineChallenge, performMachineOperation } from '../services/machine-operation.service.js';
import { createMachineRecoveryChallenge, recoverMachineCredential } from '../services/machine-recovery.service.js';
import { machineCheckpoint, machineFeed, reconcileMachineFences } from '../services/machine-events.service.js';
import { acknowledgeMachineConsumer, machineReadyChallenge, MachineReadyInput } from '../services/machine-delivery.service.js';
import { registerMachineHttpErrors } from '../services/machine-http-errors.js';

export function registerMachineRoutes(app: FastifyInstance): void {
  app.get('/schemas/machine-enrollment-v1.json', async () => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema', version: 1, capability: MACHINE_CAPABILITY,
    binding: z.toJSONSchema(MachineBinding), operation: z.toJSONSchema(MachineOperationWithProof),
    recovery: z.toJSONSchema(MachineRecoveryInput), decision: z.toJSONSchema(MachineDecisionResponse),
    authorization_request: z.toJSONSchema(MachineRequestInput), transcript_fields: z.toJSONSchema(MachineTranscriptFields),
    recovery_response: z.toJSONSchema(MachineRecoveryResponse), unavailable: z.toJSONSchema(MachineUnavailableOutcome),
  }));
  app.register(async routes => {
    registerMachineHttpErrors(routes);
    const limiter = createRateLimiter({ keyBuilder: request => `machine:${request.config?.domain ?? request.ip}`,
      limit: 600, windowMs: 60000 });
    routes.addHook('preHandler', configVerifier);
    routes.addHook('preHandler', requireDomainHashAuth);
    routes.addHook('preHandler', limiter);
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'private, no-store'); return payload;
    });
    const domain = (request: { config?: { domain: string } }) => request.config?.domain ?? machineRefused();
    routes.get('/capabilities', async () => machineCapabilities);
    routes.post('/management', async request => {
      z.object({}).strict().parse(request.body);
      const url = new URL('/auth', getPublicBaseUrl());
      if (!request.configUrl) machineRefused();
      url.searchParams.set('config_url', request.configUrl); url.searchParams.set('machine_management', 'true');
      url.searchParams.set('code_challenge', machineMac('management-pkce', request.id));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', machineMac('management-state', request.id));
      return { version: 1, management_url: url.toString() };
    });
    routes.post('/authorization-requests', async request => {
      if (!request.config || !request.configUrl) machineRefused();
      return createMachineRequest(domain(request), request.configUrl, request.config, request.body);
    });
    routes.post('/authorization-requests/:requestId/proof', async request => {
      const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
      const { proof } = z.object({ proof: MachineProof }).strict().parse(request.body);
      return proveMachineRequest(domain(request), requestId, proof);
    });
    routes.post('/authorization-requests/:requestId/result', async request => {
      const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
      z.object({}).strict().parse(request.body);
      return machineTransaction(tx => machineRequestResult(domain(request), requestId, tx));
    });
    routes.post('/challenges', async request => {
      const input = MachineChallengeInput.parse(request.body);
      return createMachineChallenge(domain(request), input.operation, input.request);
    });
    for (const operation of ['validate', 'rotate', 'revoke'] as const) {
      routes.post(`/enrollments/${operation}`, async request => {
        const { proof, ...input } = MachineOperationWithProof.parse(request.body);
        return performMachineOperation(domain(request), operation, input, proof);
      });
    }
    routes.post('/recovery/challenge', async request => createMachineRecoveryChallenge(domain(request), request.body));
    routes.post('/recovery', async request => {
      const { proof, ...input } = MachineRecoveryInput.extend({ proof: MachineProof }).strict().parse(request.body);
      return recoverMachineCredential(domain(request), input, proof);
    });
    routes.post('/revocations/checkpoint', async request => {
      z.object({}).strict().parse(request.body); return machineCheckpoint(domain(request));
    });
    routes.get('/revocations', async request => {
      const { cursor, limit } = z.object({ domain: z.string(), config_url: z.string(),
        cursor: z.string().min(1).max(2000), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict().parse(request.query);
      return machineFeed(domain(request), cursor, limit);
    });
    routes.post('/reconcile', async request => {
      const { enrollment_ids } = z.object({ enrollment_ids: z.array(z.uuid()).min(1).max(100) }).strict().parse(request.body);
      return machineTransaction(tx => reconcileMachineFences(domain(request), enrollment_ids, tx));
    });
    routes.post('/revocation-consumer/challenge', async request => {
      z.object({}).strict().parse(request.body); return machineReadyChallenge(domain(request));
    });
    routes.post('/revocation-consumer/ready', async request => machineBoundary(() =>
      acknowledgeMachineConsumer(domain(request), MachineReadyInput.parse(request.body))));
  }, { prefix: '/machine/v1' });
}
