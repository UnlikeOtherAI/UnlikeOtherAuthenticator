import type { EndpointSchema } from './schema.js';

const auth = 'current admin-domain SUPERUSER access token plus verified signed config';
const query = { domain: 'exact verified config domain', config_url: 'signed config URL' };
const admission = 'Current ACTIVE organisation required. Group additions/admin-flag changes recheck the exact org membership after user/directory locks; missing/REMOVED membership or DELETING/DELETED subject is refused. Cross-origin UOA subjects are resolved centrally. DEACTIVATED membership metadata is retained and grants no active access.';
const root = '/internal/org/organisations/:orgId';
const groupResponse = { id: 'group id', orgId: 'organisation id', name: 'string', description: 'string|null', createdAt: 'ISO timestamp', updatedAt: 'ISO timestamp' };
const memberResponse = { id: 'membership id', groupId: 'group id', userId: 'subject', isAdmin: 'boolean', avatarImageUrl: 'authenticated avatar URL', createdAt: 'ISO timestamp', updatedAt: 'ISO timestamp' };
export const internalOrgGroupEndpoints: EndpointSchema[] = [
  { method: 'POST', path: `${root}/groups`, description: 'Create an organisation group', auth, query,
    body: { name: 'string', description: 'optional string' }, response: groupResponse },
  { method: 'PUT', path: `${root}/groups/:groupId`, description: 'Update group metadata', auth, query,
    body: { name: 'optional string', description: 'optional string|null' }, response: groupResponse },
  { method: 'DELETE', path: `${root}/groups/:groupId`, description: 'Delete a group and clear team assignments', auth, query, response: { ok: 'true' } },
  { method: 'POST', path: `${root}/groups/:groupId/members`, description: 'Add a current organisation member to a group', auth, query,
    body: { userId: 'stable UOA subject', isAdmin: 'optional boolean, default false' }, response: memberResponse, notes: admission },
  { method: 'PUT', path: `${root}/groups/:groupId/members/:userId`, description: 'Set a current group member administrative flag', auth, query,
    body: { isAdmin: 'boolean' }, response: memberResponse, notes: admission },
  { method: 'DELETE', path: `${root}/groups/:groupId/members/:userId`, description: 'Remove a group membership', auth, query, response: { ok: 'true' } },
  { method: 'PUT', path: `${root}/teams/:teamId/group`, description: 'Assign a team to an exact organisation group or clear assignment', auth, query,
    body: { groupId: 'group id|null' }, response: { id: 'team id', orgId: 'organisation id', groupId: 'group id|null', name: 'string', slug: 'string',
      description: 'string|null', isDefault: 'boolean', joinPolicy: 'existing join policy', iconUrl: 'existing icon URL|null', avatarImageUrl: 'authenticated avatar URL', createdAt: 'ISO timestamp', updatedAt: 'ISO timestamp' } },
];
