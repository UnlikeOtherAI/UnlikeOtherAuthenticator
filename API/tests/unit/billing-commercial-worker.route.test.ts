import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
const services = vi.hoisted(() => ({ ack: vi.fn(), events: vi.fn(), observe: vi.fn(), ensure: vi.fn(), release: vi.fn() }));
vi.mock('../../src/middleware/billing-app-auth.js', () => ({
  requireBillingCommercialWorkerKey: async (request: { billingAppKey?: unknown }) => { request.billingAppKey = { id: 'worker' }; },
  requireBillingEntitlementAppKey: vi.fn(),
}));
vi.mock('../../src/services/billing-storage-expansion.service.js', () => ({ ensureStorageCapacity: services.ensure,
  recordStorageObservation: services.observe }));
vi.mock('../../src/services/billing-commercial-events.service.js', () => ({ acknowledgeCommercialEvent: services.ack,
  listCommercialEvents: services.events }));
vi.mock('../../src/services/billing-phone-release.service.js', () => ({ phoneReleaseVerdict: services.release }));
import { registerCommercialWorkerRoutes } from '../../src/routes/billing/commercial-worker.js';

describe('commercial worker wire contract', () => {
  beforeEach(() => { vi.clearAllMocks(); services.ack.mockResolvedValue({ accepted: true });
    services.observe.mockResolvedValue({ accepted: true, superseded: false, revision: '4' }); });
  async function app() {
    const server = Fastify();
    server.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : 500).send({ error: 'invalid request' }));
    registerCommercialWorkerRoutes(server);
    await server.ready(); return server;
  }
  it('acknowledges exactly once over the strict no-store consumer transport', async () => {
    const server = await app();
    try {
      const response = await server.inject({ method: 'POST', url: '/billing/v1/commercial-events/acknowledge', payload: {
        product: 'nessie', organisation_id: 'company', event_id: 'event', recipient_user_id: 'owner',
        channel: 'personal_assistant', receipt_id: 'transport-accepted',
      } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ accepted: true }); expect(services.ack).toHaveBeenCalledTimes(1);
    } finally { await server.close(); }
  });
  it('refuses fabricated email acceptance before reaching persistence', async () => {
    const server = await app();
    try {
      const response = await server.inject({ method: 'POST', url: '/billing/v1/commercial-events/acknowledge', payload: {
        product: 'nessie', organisation_id: 'company', event_id: 'event', recipient_user_id: 'owner',
        channel: 'email', receipt_id: 'fabricated',
      } });
      expect(response.statusCode).toBe(400); expect(services.ack).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it('requires versioned observations and returns a no-store current revision', async () => {
    const server = await app();
    try {
      const payload = { product: 'nessie', organisation_id: 'company', observation_id: 'snapshot', revision: '4',
        measurement_version: 'persisted-content-v1', observed_at: new Date().toISOString(), blob_bytes: '7', database_bytes: '8' };
      const response = await server.inject({ method: 'POST', url: '/billing/v1/storage/observations', payload });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ accepted: true, superseded: false, revision: '4' });
      const { measurement_version: _version, ...unversioned } = payload;
      const bad = await server.inject({ method: 'POST', url: '/billing/v1/storage/observations', payload: unversioned });
      expect(bad.statusCode).toBe(400); expect(services.observe).toHaveBeenCalledTimes(1);
    } finally { await server.close(); }
  });
});
