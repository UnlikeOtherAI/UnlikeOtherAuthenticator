import type { EndpointSchema } from './schema.js';
const operator = 'current online Admin-domain superuser bearer, rechecked epoch/lifecycle/role';
const owner = 'active domain pairing plus exactly one current person credential; ACTIVE canonical org owner only; no backend mode';
const query = { domain: 'exact verified domain', config_url: 'verified signed config URL' };
const base = '/internal/admin/directory-credentials';
const grant = '/org/organisations/:orgId/product-access';
const subject = '/directory/v1/organisations/:orgId/subjects/:userId';
export const directoryEndpoints: EndpointSchema[] = [
  { method: 'GET', path: base, auth: operator, description: 'List at most200 directory credential metadata rows, newest first, secret prefixes/expiry only. No plaintext/digest. Private/no-store.' },
  { method: 'POST', path: base, auth: operator, description: 'Issue a separate purpose-bound product directory credential; creates no org grant. Secret returned once; private/no-store.',
    body: { client_domain_id: 'active ClientDomain stable id', label: 'trimmed1-120characters', expires_at: 'ISO expiry greater than now, at most90days' },
    response: { id: 'stable credential id', secret: 'one-time uoa_dir_ credential; backend secret store only', expires_at: 'ISO UTC' } },
  { method: 'POST', path: base + '/:credentialId/rotate', auth: operator, description: 'Rotate the directory secret while preserving exact grants; prior secrets expire after bounded explicit overlap; private/no-store.',
    body: { overlap_seconds: 'integer0-600 required' } },
  { method: 'POST', path: base + '/:credentialId/revoke', auth: operator, body: {}, description: 'Revoke directory authority; every following read rechecks it under the policy lock. Never revokes person sessions.' },
  { method: 'GET', path: grant, auth: owner, query, description: 'List at most200 exact-org product-access grants and public credential metadata; no secret. No implicit grants.' },
  { method: 'PUT', path: grant + '/:credentialId', auth: owner, query, description: 'Explicitly grant or replace exact-org permissions to an active product directory credential; audited atomically. Does not copy identity or grant person membership.',
    body: { permissions: 'nonempty array of MEMBERSHIP_READ, DISPLAY_READ, WEBHOOK_MANAGE; independently selected. WEBHOOK_MANAGE is reserved for the separate delivery API and does not enable a webhook by itself.' } },
  { method: 'DELETE', path: grant + '/:credentialId', auth: owner, query, description: 'Revoke the exact product/org grant atomically and audit; subsequent directory reads fail. No membership/session changes.' },
  { method: 'GET', path: subject + '/standing', auth: 'purpose-bound uoa_dir_ bearer and active exact-org MEMBERSHIP_READ grant; domain/billing/user credentials are refused',
    description: 'Live exact subject standing. Inactive/missing membership/account/org returns subject/organisation_id/active:false; active returns credential_epoch, org_role and exact ACTIVE teams {id,role}, max200 or503. No email/name/profile. Private/no-store. This direct read is not a revisioned snapshot/delta or permission to cache durable memberships.' },
  { method: 'GET', path: subject + '/display', auth: 'purpose-bound uoa_dir_ bearer and active exact-org DISPLAY_READ grant',
    description: 'Minimal authorized exact-org display: active id/name/avatar_image_url/deleted:false; removed Former member or other inactive Unavailable member without avatar; retained deleted id/name:Deleted user/deleted:true; unproven/erased generic404. No email/authentication factors. Private/no-store; bounded in-memory use only.' },
  { method: 'GET', path: subject + '/avatar', auth: 'same active DISPLAY_READ credential/grant, ACTIVE exact target membership/account/org', description: 'Canonical image bytes, private/no-store; inactive/deleted/unproven generic404. Image requires this same purpose-bound credential.' },
];
