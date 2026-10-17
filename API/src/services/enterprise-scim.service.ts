import { randomBytes } from 'node:crypto';
import type { Prisma, ScimResourceLink } from '@prisma/client';
import { z } from 'zod';
import { getAdminPrisma } from '../db/prisma.js';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { lockEnterpriseScope } from './org-sso-management.service.js';
import { revokeEnterpriseScope } from './org-sso-revocation.service.js';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const scimBase = (id: string): string => `${getPublicBaseUrl()}/scim/v2/c/${id}`;
const boundedValue = z.string().max(500);
const Resource = z.object({ schemas: z.array(z.string()).max(5), externalId: boundedValue.optional(),
  userName: boundedValue.optional(), displayName: boundedValue.optional(), active: z.boolean().optional(),
  name: z.object({ givenName: boundedValue.optional(), familyName: boundedValue.optional(), formatted: boundedValue.optional() }).strict().optional(),
  emails: z.array(z.object({ value: boundedValue, primary: z.boolean().optional(), type: boundedValue.optional() }).strict()).max(10).optional(),
  members: z.array(z.object({ value: z.string().max(100), display: boundedValue.optional(), '$ref': boundedValue.optional() }).strict()).max(500).optional(),
}).strict();
type Attributes = z.infer<typeof Resource>;

export function scimResource(row: ScimResourceLink) {
  const attrs = Resource.parse(row.attributes);
  return { ...attrs, schemas: [row.resourceType === 'Users' ? USER : GROUP], id: row.id,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.resourceType === 'Users' ? { active: row.active && !row.deletedAt } : {}),
    meta: { resourceType: row.resourceType === 'Users' ? 'User' : 'Group',
      created: row.createdAt.toISOString(), lastModified: row.updatedAt.toISOString(),
      version: `W/"${row.version}"`, location: `${scimBase(row.connectionId)}/${row.resourceType}/${row.id}` } };
}
export async function authenticateScim(connectionId: string, bearer: string | undefined) {
  if (!bearer?.startsWith('Bearer ') || bearer.length > 300) throw new AppError('UNAUTHORIZED', 401);
  const db = getAdminPrisma();
  const token = await db.scimConnectionToken.findUnique({ where: { tokenHash: hashAssuranceReference(bearer.slice(7)) },
    include: { connection: true } });
  if (!token || token.connectionId !== connectionId || token.revokedAt || token.expiresAt <= new Date() ||
    token.connection.status !== 'active') throw new AppError('UNAUTHORIZED', 401);
  return token;
}
export async function issueScimToken(connectionId: string, db: Prisma.TransactionClient) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 90 * 86400000);
  // Two live tokens maximum supports deliberate overlap without unbounded credential accumulation.
  if (await db.scimConnectionToken.count({ where: { connectionId, revokedAt: null, expiresAt: { gt: new Date() } } }) >= 2) {
    throw new AppError('BAD_REQUEST', 409, 'SCIM_TOKEN_ROTATION_REQUIRED');
  }
  await db.scimConnectionToken.create({ data: { connectionId, tokenHash: hashAssuranceReference(token), expiresAt } });
  return { ok: true, token, base_url: scimBase(connectionId), expires_at: expiresAt.toISOString() };
}

/** Supported filter subset is exact and connection-scoped; no global identity search. */
export function parseScimFilter(filter: string | undefined): { key: 'id' | 'externalId' | 'userName' | 'displayName'; value: string } | null {
  if (!filter) return null;
  const match = /^(id|externalId|userName|displayName) eq ("(?:[^"\\]|\\["\\])*")$/.exec(filter);
  if (!match || filter.length > 1000) throw new AppError('BAD_REQUEST', 400, 'SCIM_INVALID_FILTER');
  return { key: match[1] as 'id' | 'externalId' | 'userName' | 'displayName', value: JSON.parse(match[2]) as string };
}
export async function listScimResources(connectionId: string, resourceType: string,
  query: { filter?: string; startIndex: number; count: number }) {
  const filter = parseScimFilter(query.filter);
  const where: Prisma.ScimResourceLinkWhereInput = { connectionId, resourceType, deletedAt: null,
    ...(filter?.key === 'id' ? { id: filter.value } : {}),
    ...(filter?.key === 'externalId' ? { externalId: filter.value } : {}),
    ...(filter && ['userName', 'displayName'].includes(filter.key)
      ? { attributes: { path: [filter.key], equals: filter.value } } : {}) };
  const db = getAdminPrisma();
  const [totalResults, rows] = await Promise.all([db.scimResourceLink.count({ where }),
    db.scimResourceLink.findMany({ where, orderBy: { id: 'asc' }, skip: query.startIndex - 1, take: query.count })]);
  return { schemas: [LIST], totalResults, startIndex: query.startIndex, itemsPerPage: rows.length,
    Resources: rows.map(scimResource) };
}

export function applyScimPatch(prior: Attributes, raw: unknown): Attributes {
  const patch = z.object({ schemas: z.array(z.string()), Operations: z.array(z.object({
    op: z.enum(['add', 'Add', 'replace', 'Replace', 'remove', 'Remove']),
    path: z.string().max(300).optional(), value: z.unknown().optional(),
  }).strict()).min(1).max(100) }).strict().parse(raw);
  if (!patch.schemas.includes('urn:ietf:params:scim:api:messages:2.0:PatchOp')) throw new AppError('BAD_REQUEST', 400, 'SCIM_INVALID_SYNTAX');
  const next: Record<string, unknown> = structuredClone(prior);
  for (const operation of patch.Operations) {
    const op = operation.op.toLowerCase();
    if (!operation.path) {
      if (op === 'remove' || !operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) {
        throw new AppError('BAD_REQUEST', 400, 'SCIM_INVALID_PATH');
      }
      Object.assign(next, Resource.partial().parse(operation.value));
      continue;
    }
    const member = /^members\[value eq ("(?:[^"\\]|\\["\\])*")\]$/.exec(operation.path);
    if (member && op === 'remove') {
      const value = JSON.parse(member[1]) as string;
      next.members = (prior.members ?? []).filter((m) => m.value !== value);
      continue;
    }
    if (!['active', 'userName', 'displayName', 'name', 'emails', 'members', 'externalId'].includes(operation.path)) {
      throw new AppError('BAD_REQUEST', 400, 'SCIM_INVALID_PATH');
    }
    if (op === 'remove') Reflect.deleteProperty(next, operation.path);
    else if (op === 'add' && operation.path === 'members') {
      next.members = [...(next.members as unknown[] ?? []), ...(Array.isArray(operation.value) ? operation.value : [operation.value])];
    } else next[operation.path] = operation.value;
  }
  return Resource.parse(next);
}

export async function mutateScimResource(connectionId: string, resourceType: string, raw: unknown,
  options: { id?: string; patch?: boolean; remove?: boolean; ifMatch?: string }) {
  const db = getAdminPrisma();
  return db.$transaction(async (tx) => {
    const connection = await tx.orgSsoConnection.findUniqueOrThrow({ where: { id: connectionId } });
    await lockEnterpriseScope(tx, connection.clientDomain, connection.orgId);
    if (connection.status !== 'active') throw new AppError('UNAUTHORIZED', 401);
    const prior = options.id ? await tx.scimResourceLink.findFirst({ where: {
      id: options.id, connectionId, resourceType, deletedAt: null } }) : null;
    if (options.id && !prior) throw new AppError('NOT_FOUND', 404);
    if (prior && options.ifMatch && options.ifMatch !== `W/"${prior.version}"`) throw new AppError('BAD_REQUEST', 412, 'SCIM_VERSION_MISMATCH');
    if (options.remove && prior) {
      const row = await tx.scimResourceLink.update({ where: { id: prior.id }, data: {
        active: false, deletedAt: new Date(), version: { increment: 1 } } });
      await suspendManagedSource(row, tx);
      return null;
    }
    const attrs = options.patch && prior ? applyScimPatch(Resource.parse(prior.attributes), raw) : Resource.parse(raw);
    if (!attrs.schemas.includes(resourceType === 'Users' ? USER : GROUP)) throw new AppError('BAD_REQUEST', 400, 'SCIM_INVALID_SYNTAX');
    if (resourceType === 'Users' && !attrs.userName) throw new AppError('BAD_REQUEST', 400, 'SCIM_USER_NAME_REQUIRED');
    if (resourceType === 'Groups' && !attrs.displayName) throw new AppError('BAD_REQUEST', 400, 'SCIM_GROUP_NAME_REQUIRED');
    if (!prior && attrs.externalId) {
      const duplicate = await tx.scimResourceLink.findUnique({ where: { connectionId_resourceType_externalId: {
        connectionId, resourceType, externalId: attrs.externalId } } });
      if (duplicate) {
        if (!duplicate.deletedAt && JSON.stringify(duplicate.attributes) === JSON.stringify(attrs)) return scimResource(duplicate);
        throw new AppError('BAD_REQUEST', 409, 'SCIM_UNIQUENESS');
      }
    }
    // externalId changes are a reconciliation migration, never an email-based relink.
    if (prior && prior.externalId !== (attrs.externalId ?? null)) throw new AppError('BAD_REQUEST', 409, 'SCIM_RECONCILIATION_REQUIRED');
    const data = { attributes: attrs as Prisma.InputJsonValue, externalId: attrs.externalId ?? null,
      active: attrs.active ?? true };
    const row = prior ? await tx.scimResourceLink.update({ where: { id: prior.id }, data: {
      ...data, version: { increment: 1 } } }) : await tx.scimResourceLink.create({ data: {
      ...data, connectionId, clientDomain: connection.clientDomain, orgId: connection.orgId, resourceType } });
    if (!row.active) await suspendManagedSource(row, tx);
    // Unreconciled resources remain connection-scoped pending records. Neither email nor
    // externalId implies possession of a UOA account or an OIDC/SAML subject.
    return scimResource(row);
  });
}

async function suspendManagedSource(row: ScimResourceLink, tx: Prisma.TransactionClient) {
  if (!row.userId) return;
  await tx.orgSsoGrant.updateMany({ where: { connectionId: row.connectionId, resourceId: row.id,
    userId: row.userId }, data: { revokedAt: new Date() } });
  await tx.externalIdentity.updateMany({ where: { connectionId: row.connectionId, userId: row.userId }, data: { status: 'SUSPENDED' } });
  await revokeEnterpriseScope({ scope: 'connection', clientDomain: row.clientDomain, orgId: row.orgId,
    connectionId: row.connectionId, userId: row.userId, revision: row.version }, tx);
}
