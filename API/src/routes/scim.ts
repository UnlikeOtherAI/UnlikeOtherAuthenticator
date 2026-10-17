import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminPrisma } from '../db/prisma.js';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { authenticateScim, listScimResources, mutateScimResource, scimResource,
  SCIM_ERROR } from '../services/enterprise-scim.service.js';
import { AppError } from '../utils/errors.js';

export function registerScimRoutes(app: FastifyInstance): void {
  const base = '/scim/v2/c/:connectionId';
  const rate = createRateLimiter({ keyBuilder: (request) => `scim:${request.ip}`, limit: 120, windowMs: 60000 });
  const authorize = async (request: Parameters<typeof rate>[0]) => {
    const { connectionId } = z.object({ connectionId: z.string().min(1).max(100) }).passthrough().parse(request.params);
    await authenticateScim(connectionId, typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined);
  };
  const preHandler = [rate, authorize];
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.url.startsWith('/scim/v2/c/')) return payload;
    reply.header('Cache-Control', 'no-store').type('application/scim+json');
    if (reply.statusCode >= 400) return JSON.stringify({ schemas: [SCIM_ERROR], status: String(reply.statusCode),
      detail: 'The provisioning request could not be completed.' });
    return payload;
  });
  app.get(`${base}/ServiceProviderConfig`, { preHandler }, async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 }, changePassword: { supported: false },
    sort: { supported: false }, etag: { supported: true },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Connection bearer',
      description: 'Dedicated connection-scoped provisioning bearer', primary: true }],
  }));
  app.get(`${base}/ResourceTypes`, { preHandler }, async () => ({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 2,
    Resources: ['User', 'Group'].map((type) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: type, name: type, endpoint: `/${type}s`, schema: `urn:ietf:params:scim:schemas:core:2.0:${type}` })),
  }));
  app.get(`${base}/Schemas`, { preHandler }, async () => ({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 2,
    Resources: ['User', 'Group'].map((type) => ({ id: `urn:ietf:params:scim:schemas:core:2.0:${type}`, name: type,
      attributes: (type === 'User' ? ['userName', 'displayName', 'active', 'emails', 'name'] : ['displayName', 'members'])
        .map((name) => ({ name, type: name === 'active' ? 'boolean' : ['members', 'emails', 'name'].includes(name) ? 'complex' : 'string',
          multiValued: ['members', 'emails'].includes(name), required: name === (type === 'User' ? 'userName' : 'displayName'),
          mutability: 'readWrite', returned: 'default', uniqueness: 'none' })) })),
  }));
  for (const resourceType of ['Users', 'Groups']) {
    const path = `${base}/${resourceType}`;
    app.get(path, { preHandler }, async (request) => {
      const { connectionId } = z.object({ connectionId: z.string() }).parse(request.params);
      const query = z.object({ filter: z.string().max(1000).optional(), startIndex: z.coerce.number().int().min(1).default(1),
        count: z.coerce.number().int().min(0).max(200).default(100) }).strict().parse(request.query);
      return listScimResources(connectionId, resourceType, query);
    });
    app.get(`${path}/:id`, { preHandler }, async (request, reply) => {
      const { connectionId, id } = z.object({ connectionId: z.string(), id: z.string() }).parse(request.params);
      const row = await getAdminPrisma().scimResourceLink.findFirst({ where: { id, connectionId, resourceType, deletedAt: null } });
      if (!row) throw new AppError('NOT_FOUND', 404);
      return reply.header('ETag', `W/"${row.version}"`).send(scimResource(row));
    });
    app.post(path, { preHandler }, async (request, reply) => {
      const { connectionId } = z.object({ connectionId: z.string() }).parse(request.params);
      const resource = await mutateScimResource(connectionId, resourceType, request.body, {});
      return reply.code(201).header('Location', resource?.meta.location ?? '').send(resource);
    });
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) app.route({ method, url: `${path}/:id`, preHandler,
      handler: async (request, reply) => {
        const { connectionId, id } = z.object({ connectionId: z.string(), id: z.string() }).parse(request.params);
        const ifMatch = typeof request.headers['if-match'] === 'string' ? request.headers['if-match'] : undefined;
        const resource = await mutateScimResource(connectionId, resourceType, request.body,
          { id, ifMatch, patch: method === 'PATCH', remove: method === 'DELETE' });
        return method === 'DELETE' ? reply.code(204).send() : reply.send(resource);
      } });
  }
}
