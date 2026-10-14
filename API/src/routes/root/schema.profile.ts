import type { EndpointSchema } from './schema.js';
const cacheNote = 'Every response, including authorization, validation, missing-subject and dependency errors, is private/no-store.';
const auth = 'active domain pairing and exactly one current user access token or one-minute RS256 X-UOA-Subject-Assertion (existing org audience); never backend-only';
const query = { domain: 'exact verified client identity', config_url: 'verified signed configuration URL' };
export const profileEndpoints: EndpointSchema[] = [
  { notes: cacheNote, method: 'GET', path: '/profile/me', auth, query,
    description: 'Read exact self profile after current lifecycle, epoch, domain-role and selected-team authorization. Private/no-store.',
    response: { id: 'stable subject', email: 'current own email only', name: 'string|null', pronouns_preset: 'preset|null',
      pronouns_custom: 'custom text|null', pronouns_display: 'server-derived string|null', avatar_url: 'authorized canonical image URL',
      avatar_image_url: 'same canonical image URL', twofa_enabled: 'boolean', created_at: 'ISO UTC' } },
  { notes: cacheNote, method: 'PATCH', path: '/profile/me', auth, query,
    description: 'Partial self profile update; same response as GET. Email, role, identity/factors and arbitrary fields refused. No local product profile store.',
    body: { name: 'optional trimmed1-200characters', pronouns_preset: 'optional null|he_him|she_her|they_them|any_pronouns|ask_me|prefer_not_to_say|custom',
      pronouns_custom: 'optional null or trimmed1-120characters; required for custom, otherwise null' } },
  { notes: cacheNote, method: 'GET', path: '/profile/me/avatar', auth, query, description: 'Authorized self avatar bytes through canonical upload/provider/generated resolver; private/no-store' },
  { notes: cacheNote, method: 'GET', path: '/org/organisations/:orgId/users/:userId/display', auth, query,
    description: 'Exact-org authorized subject display. Actor must remain ACTIVE in the exact claimed organisation. Active target membership returns id/name/deleted:false and authorized avatar_image_url; REMOVED membership returns Former member without avatar; other inactive membership/account returns Unavailable member without avatar, deleted:false. DELETED returns id/name:Deleted user/deleted:true only with exact retained org provenance. Unknown/erased/unproven subject is generic404. Never email or factor data.' },
  { notes: cacheNote, method: 'GET', path: '/org/organisations/:orgId/users/:userId/display/avatar', auth, query,
    description: 'Same exact-org current actor and ACTIVE target membership checks; inactive/deleted/unknown generic404. Private/no-store raster or generated image bytes.' },
];
