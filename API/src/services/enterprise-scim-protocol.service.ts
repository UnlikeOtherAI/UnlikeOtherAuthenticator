import { z } from 'zod';
import { AppError } from '../utils/errors.js';

export const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const bounded = z.string().max(500);
const Member = z.object({ value: z.string().min(1).max(100), display: bounded.nullish(), '$ref': bounded.nullish() }).strict();
const Email = z.object({ value: bounded, primary: z.boolean().optional(), type: bounded.optional() }).strict();
const Name = z.object({ givenName: bounded.optional(), familyName: bounded.optional(), formatted: bounded.optional(),
  middleName: bounded.optional(), honorificPrefix: bounded.optional(), honorificSuffix: bounded.optional() }).strict();
export const ScimAttributes = z.object({ schemas: z.array(z.string().max(200)).min(1).max(10), externalId: bounded.optional(),
  userName: bounded.optional(), displayName: bounded.optional(), active: z.boolean().optional(), name: Name.optional(),
  emails: z.array(Email).max(10).optional(), members: z.array(Member).max(500).optional(),
  nickName: bounded.optional(), profileUrl: bounded.optional(), title: bounded.optional(), userType: bounded.optional(),
  preferredLanguage: bounded.optional(), locale: bounded.optional(), timezone: bounded.optional(),
  [ENTERPRISE]: z.object({ employeeNumber: bounded.optional(), costCenter: bounded.optional(), organization: bounded.optional(),
    division: bounded.optional(), department: bounded.optional(), manager: z.object({ value: bounded.optional(),
      '$ref': bounded.nullish(), displayName: bounded.optional() }).strict().optional() }).strict().optional(),
}).strict();
export type ScimAttributesValue = z.infer<typeof ScimAttributes>;
const names = new Map(['schemas', 'externalId', 'userName', 'displayName', 'active', 'name', 'emails', 'members', 'nickName',
  'profileUrl', 'title', 'userType', 'preferredLanguage', 'locale', 'timezone', ENTERPRISE,
  'givenName', 'familyName', 'formatted', 'middleName', 'honorificPrefix', 'honorificSuffix', 'value', 'primary', 'type', 'display', '$ref',
  'employeeNumber', 'costCenter', 'organization', 'division', 'department', 'manager'].map((name) => [name.toLowerCase(), name]));
function invalid(code = 'SCIM_INVALID_SYNTAX'): never { throw new AppError('BAD_REQUEST', 400, code); }
function normalize(value: unknown, depth = 0): unknown {
  if (depth > 5) invalid();
  if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['meta', 'id'].includes(key.toLowerCase())) continue; // Read-only provider echo has no authority.
    const canonical = names.get(key.toLowerCase());
    if (!canonical) {
      if (item === null && ['addresses', 'phoneNumbers', 'ims', 'photos', 'roles', 'entitlements', 'x509Certificates'].some((name) => name.toLowerCase() === key.toLowerCase())) continue;
      invalid('SCIM_INVALID_PATH');
    }
    if (Object.hasOwn(result, canonical)) invalid();
    if (item !== null) result[canonical] = normalize(item, depth + 1);
  }
  return result;
}
export function parseScimAttributes(raw: unknown): ScimAttributesValue {
  const parsed = ScimAttributes.parse(normalize(raw));
  if (parsed.members) parsed.members = [...new Map(parsed.members.map((member) => [member.value, member])).values()];
  return parsed;
}

/** Deliberately bounded supported filter dialect; never searches canonical people by email. */
export function parseScimFilter(filter: string | undefined): { key: 'id' | 'externalId' | 'userName' | 'displayName'; value: string } | null {
  if (!filter) return null;
  const match = /^\s*(id|externalId|userName|displayName)\s+eq\s+("(?:[^"\\]|\\["\\])*")\s*$/i.exec(filter);
  if (!match || filter.length > 1000) invalid('SCIM_INVALID_FILTER');
  const key = match[1].toLowerCase() === 'id' ? 'id' : names.get(match[1].toLowerCase());
  return { key: key as 'id' | 'externalId' | 'userName' | 'displayName', value: JSON.parse(match[2]) as string };
}

/** Sequential RFC operations plus Entra's explicit remove-members value list. */
export function applyScimPatch(prior: ScimAttributesValue, raw: unknown): ScimAttributesValue {
  const patch = z.object({ schemas: z.array(z.string()).max(10), Operations: z.array(z.object({
    op: z.string().refine((op) => ['add', 'replace', 'remove'].includes(op.toLowerCase())),
    path: z.string().max(500).optional(), value: z.unknown().optional(),
  }).strict()).min(1).max(100) }).strict().parse(raw);
  if (!patch.schemas.includes('urn:ietf:params:scim:api:messages:2.0:PatchOp')) invalid();
  const next: Record<string, unknown> = structuredClone(prior);
  for (const operation of patch.Operations) {
    const op = operation.op.toLowerCase();
    if (!operation.path) {
      if (op === 'remove' || !operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) invalid('SCIM_INVALID_PATH');
      const values = ScimAttributes.partial().parse(normalize(operation.value));
      for (const [key, value] of Object.entries(values)) {
        if (op === 'add' && ['members', 'emails'].includes(key)) next[key] = [...(next[key] as unknown[] ?? []), ...(value as unknown[])];
        else next[key] = value;
      }
      continue;
    }
    const member = /^members\[value\s+eq\s+("(?:[^"\\]|\\["\\])*")\]$/i.exec(operation.path);
    if (member) {
      if (op !== 'remove') invalid('SCIM_INVALID_PATH');
      const value = JSON.parse(member[1]) as string;
      next.members = (next.members as ScimAttributesValue['members'] ?? []).filter((item) => item.value !== value);
      continue;
    }
    const name = /^name\.(givenName|familyName|middleName|formatted|honorificPrefix|honorificSuffix)$/i.exec(operation.path);
    if (name) {
      const field = names.get(name[1].toLowerCase());
      if (!field) invalid('SCIM_INVALID_PATH');
      const value = { ...(next.name as object ?? {}) } as Record<string, unknown>;
      if (op === 'remove') Reflect.deleteProperty(value, field); else value[field] = bounded.parse(operation.value);
      next.name = value; continue;
    }
    const key = names.get(operation.path.toLowerCase());
    if (!key || ['schemas', 'id', 'meta'].includes(key)) invalid('SCIM_INVALID_PATH');
    if (op === 'remove' && key === 'members' && operation.value !== undefined) {
      const remove = z.array(Member).max(500).parse(normalize(operation.value));
      const values = new Set(remove.map((item) => item.value));
      next.members = (next.members as ScimAttributesValue['members'] ?? []).filter((item) => !values.has(item.value));
    } else if (op === 'remove') Reflect.deleteProperty(next, key);
    else if (op === 'add' && ['members', 'emails'].includes(key)) {
      const values = normalize(Array.isArray(operation.value) ? operation.value : [operation.value]);
      next[key] = [...(next[key] as unknown[] ?? []), ...(values as unknown[])];
    } else next[key] = normalize(operation.value);
  }
  return parseScimAttributes(next);
}

/** Always-returned IDs/schema/meta survive attribute projection. */
export function projectScimResource<T extends Record<string, unknown>>(resource: T,
  query: { attributes?: string; excludedAttributes?: string }): Record<string, unknown> {
  const namesFor = (raw?: string) => raw?.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  const include = namesFor(query.attributes); const exclude = namesFor(query.excludedAttributes);
  if ((include?.length ?? 0) > 30 || (exclude?.length ?? 0) > 30) invalid('SCIM_INVALID_PATH');
  const select = (value: unknown, wanted: string[] | undefined, removed: string[] | undefined): unknown => {
    if (Array.isArray(value)) return value.map((item) => select(item, wanted, removed));
    if (!value || typeof value !== 'object') return value;
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(value)) {
      const lower = key.toLowerCase(); const prefix = `${lower}.`;
      if (removed?.includes(lower)) continue;
      const children = wanted?.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
      if (wanted && !wanted.includes(lower) && !children?.length) continue;
      const excludedChildren = removed?.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
      entries.push([key, select(item, !wanted || wanted.includes(lower) ? undefined : children, excludedChildren)]);
    }
    return Object.fromEntries(entries);
  };
  const result = select(resource, include, exclude) as Record<string, unknown>;
  for (const key of ['id', 'schemas', 'meta']) if (Object.hasOwn(resource, key)) result[key] = resource[key];
  return result;
}
