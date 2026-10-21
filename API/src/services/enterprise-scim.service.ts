import { parseScimAttributes, applyScimPatch, parseScimFilter,
  SCIM_USER as USER, SCIM_GROUP as GROUP, SCIM_LIST as LIST } from './enterprise-scim-protocol.service.js';
export { applyScimPatch, parseScimFilter, SCIM_ERROR } from './enterprise-scim-protocol.service.js';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma, type ScimResourceLink } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';
import { getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { hashAssuranceReference } from './session-assurance.service.js';
import { lockEnterpriseScope } from './org-sso-management.service.js';
import { lockEnterpriseOutbox } from './org-sso-revocation.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { reconcileScimUsers, validateScimMembers } from './enterprise-scim-reconciliation.service.js';

export const scimBase = (id: string): string => `${getPublicBaseUrl()}/scim/v2/c/${id}`;
export function scimResource(row: ScimResourceLink) {
  const attrs = parseScimAttributes(row.attributes);
  return { ...attrs, schemas: [...new Set([row.resourceType === 'Users' ? USER : GROUP,
    ...attrs.schemas.filter((schema) => Object.hasOwn(attrs, schema))])], id: row.id,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.resourceType === 'Users' ? { active: row.active && !row.deletedAt } : {}),
    meta: { resourceType: row.resourceType === 'Users' ? 'User' : 'Group',
      created: row.createdAt.toISOString(), lastModified: row.updatedAt.toISOString(),
      version: `W/"${row.version}"`, location: `${scimBase(row.connectionId)}/${row.resourceType}/${row.id}` } };
}
export async function authenticateScim(connectionId: string, bearer: string | undefined, db = getAdminPrisma() as Prisma.TransactionClient) {
  const authorization = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(bearer ?? '');
  if (!authorization) throw new AppError('UNAUTHORIZED', 401);
  const token = await db.scimConnectionToken.findUnique({ where: { tokenHash: hashAssuranceReference(authorization[1]) },
    include: { connection: true } });
  if (!token || token.connectionId !== connectionId || token.revokedAt || token.expiresAt <= new Date() ||
    !token.connection.scimEnabled || ['disabled', 'suspended'].includes(token.connection.status)) throw new AppError('UNAUTHORIZED', 401);
  const [policy, client, org, product] = await Promise.all([
    db.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: { clientDomain: token.connection.clientDomain, orgId: token.connection.orgId } } }),
    db.clientDomain.findUnique({ where: { domain: token.connection.clientDomain }, select: { status: true } }),
    db.organisation.findUnique({ where: { id: token.connection.orgId }, select: { lifecycleStatus: true } }),
    db.enterpriseProductReadiness.findUnique({ where: { clientDomain: token.connection.clientDomain } }),
  ]);
  if (!policy?.arrangementEnabled || client?.status !== 'active' || org?.lifecycleStatus !== 'ACTIVE' ||
    product?.minimumAssuranceVersion !== 1 || !product.authorityMigrationRevision || !product.revocationConsumersRevision) throw new AppError('UNAUTHORIZED', 401);
  return token;
}
export async function issueScimToken(connectionId: string, db: Prisma.TransactionClient) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 90 * 86400000);
  // Two live tokens maximum supports deliberate overlap without unbounded credential accumulation.
  if (await db.scimConnectionToken.count({ where: { connectionId, revokedAt: null, expiresAt: { gt: new Date() } } }) >= 2) {
    throw new AppError('BAD_REQUEST', 409, 'SCIM_TOKEN_ROTATION_REQUIRED');
  }
  const row = await db.scimConnectionToken.create({ data: { connectionId, tokenHash: hashAssuranceReference(token), expiresAt } });
  return { ok: true, id: row.id, token, base_url: scimBase(connectionId), expires_at: expiresAt.toISOString() };
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
  if (filter && ['userName', 'displayName'].includes(filter.key)) {
    const condition = Prisma.sql`connection_id=${connectionId} AND resource_type=${resourceType} AND deleted_at IS NULL
      AND lower(attributes->>${filter.key})=lower(${filter.value})`;
    const [count, matches] = await Promise.all([
      db.$queryRaw<Array<{ total: bigint }>>`SELECT count(*) AS total FROM scim_resource_links WHERE ${condition}`,
      db.$queryRaw<Array<{ id: string }>>`SELECT id FROM scim_resource_links WHERE ${condition}
        ORDER BY id OFFSET ${query.startIndex - 1} LIMIT ${query.count}`,
    ]);
    const rows = await db.scimResourceLink.findMany({ where: { connectionId, resourceType, id: { in: matches.map((row) => row.id) } }, orderBy: { id: 'asc' } });
    return { schemas: [LIST], totalResults: Number(count[0]?.total ?? 0), startIndex: query.startIndex,
      itemsPerPage: rows.length, Resources: rows.map(scimResource) };
  }
  const [totalResults, rows] = await Promise.all([db.scimResourceLink.count({ where }),
    db.scimResourceLink.findMany({ where, orderBy: { id: 'asc' }, skip: query.startIndex - 1, take: query.count })]);
  return { schemas: [LIST], totalResults, startIndex: query.startIndex, itemsPerPage: rows.length,
    Resources: rows.map(scimResource) };
}

export async function mutateScimResource(connectionId: string, resourceType: string, raw: unknown,
  options: { id?: string; patch?: boolean; remove?: boolean; ifMatch?: string; bearer?: string }) {
  const db = getAdminPrisma();
  return db.$transaction(async (tx) => {
    await lockEnterpriseOutbox(tx);
    await lockProductTeamPolicyShared(tx);
    const authenticated = await authenticateScim(connectionId, options.bearer, tx);
    const connection = await tx.orgSsoConnection.findUniqueOrThrow({ where: { id: connectionId } });
    await lockEnterpriseScope(tx, connection.clientDomain, connection.orgId);
    if (authenticated.connection.clientDomain !== connection.clientDomain || authenticated.connection.orgId !== connection.orgId) throw new AppError('UNAUTHORIZED', 401);
    const prior = options.id ? await tx.scimResourceLink.findFirst({ where: {
      id: options.id, connectionId, resourceType, deletedAt: null } }) : null;
    if (options.id && !prior) throw new AppError('NOT_FOUND', 404);
    if (prior && options.ifMatch && options.ifMatch !== `W/"${prior.version}"`) throw new AppError('BAD_REQUEST', 412, 'SCIM_VERSION_MISMATCH');
    if (options.remove && prior) {
      const row = await tx.scimResourceLink.update({ where: { id: prior.id }, data: {
        active: false, deletedAt: new Date(), version: { increment: 1 } } });
      const affected = resourceType === 'Users' ? [row.id] : (parseScimAttributes(prior.attributes).members ?? []).map((member) => member.value);
      await reconcileScimUsers(connectionId, affected, tx);
      return null;
    }
    const attrs = options.patch && prior ? applyScimPatch(parseScimAttributes(prior.attributes), raw) : parseScimAttributes(raw);
    if (prior && attrs.externalId === undefined && prior.externalId !== null) attrs.externalId = prior.externalId;
    if (!attrs.schemas.includes(resourceType === 'Users' ? USER : GROUP)) throw new AppError('BAD_REQUEST', 400, 'SCIM_INVALID_SYNTAX');
    if (resourceType === 'Users' && !attrs.userName) throw new AppError('BAD_REQUEST', 400, 'SCIM_USER_NAME_REQUIRED');
    if (resourceType === 'Groups' && !attrs.displayName) throw new AppError('BAD_REQUEST', 400, 'SCIM_GROUP_NAME_REQUIRED');
    if (resourceType === 'Groups') await validateScimMembers(connectionId, attrs, tx);
    if (resourceType === 'Users') {
      const matches = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM scim_resource_links WHERE connection_id=${connectionId}
        AND resource_type='Users' AND deleted_at IS NULL AND lower(attributes->>'userName')=lower(${attrs.userName ?? ''})
        AND id<>${prior?.id ?? ''} LIMIT 1`;
      if (matches.length) {
        const duplicate = await tx.scimResourceLink.findUniqueOrThrow({ where: { id: matches[0].id } });
        if (!prior && isDeepStrictEqual(duplicate.attributes, attrs)) return scimResource(duplicate);
        throw new AppError('BAD_REQUEST', 409, 'SCIM_UNIQUENESS');
      }
    }
    if (!prior && attrs.externalId) {
      const duplicate = await tx.scimResourceLink.findUnique({ where: { connectionId_resourceType_externalId: {
        connectionId, resourceType, externalId: attrs.externalId } } });
      if (duplicate) {
        if (!duplicate.deletedAt && isDeepStrictEqual(duplicate.attributes, attrs)) return scimResource(duplicate);
        throw new AppError('BAD_REQUEST', 409, 'SCIM_UNIQUENESS');
      }
    }
    // externalId changes are a reconciliation migration, never an email-based relink.
    if (prior && prior.externalId !== (attrs.externalId ?? null)) throw new AppError('BAD_REQUEST', 409, 'SCIM_RECONCILIATION_REQUIRED');
    if (!prior && await tx.scimResourceLink.count({ where: { connectionId, resourceType } }) >= (resourceType === 'Users' ? 10000 : 1000)) {
      throw new AppError('BAD_REQUEST', 409, 'SCIM_RESOURCE_LIMIT');
    }
    const data = { attributes: attrs as Prisma.InputJsonValue, externalId: attrs.externalId ?? null,
      active: attrs.active ?? prior?.active ?? true };
    const row = prior ? await tx.scimResourceLink.update({ where: { id: prior.id }, data: {
      ...data, version: { increment: 1 } } }) : await tx.scimResourceLink.create({ data: {
      ...data, connectionId, clientDomain: connection.clientDomain, orgId: connection.orgId, resourceType } });
    const affected = resourceType === 'Users' ? [row.id] : [...new Set([
      ...(prior ? parseScimAttributes(prior.attributes).members ?? [] : []), ...(attrs.members ?? []),
    ].map((member) => member.value))];
    await reconcileScimUsers(connectionId, affected, tx);
    return scimResource(row);
  }, { timeout: 30000 });
}
