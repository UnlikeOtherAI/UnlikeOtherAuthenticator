import type { EndpointSchema } from './schema.js';

export function buildInternalAdminAppEndpoints(params: {
  adminAuth: string;
  keyedAuth: string;
  authFailures: string;
}): EndpointSchema[] {
  const { adminAuth, keyedAuth, authFailures } = params;

  return [
    {
      method: 'GET',
      path: '/internal/admin/settings',
      description: 'Admin settings backing data for bans and apps',
      auth: adminAuth,
      response: { 200: '{ bans, apps }', '401/403': authFailures },
    },
    {
      method: 'GET',
      path: '/internal/admin/apps',
      description:
        'List registered apps, each with its feature flag definitions and kill-switch rules. The discovery endpoint a terminal/CI caller uses to find the appId, flagId, and killSwitchId before writing flags or kill switches.',
      auth: keyedAuth,
      response: { 200: 'Array of app summary objects (each with flags and kill switches)', '401/403': authFailures },
    },
    {
      method: 'POST',
      path: '/internal/admin/apps',
      description: 'Register an app for feature flags and startup payload lookups',
      auth: adminAuth,
      body: {
        name: 'string (required, max 120)',
        identifier: 'string (required, max 160; unique per organisation)',
        platform: 'ios | android | web | macos | windows | linux | iot | tv | console | other',
        domain: 'string (required)',
        org_id: 'string (required)',
        offline_policy: 'allow | block | cached (optional)',
        poll_interval_seconds: 'number (optional, 30-86400)',
      },
      response: { 200: 'Created app summary object', '401/403': authFailures },
    },
    {
      method: 'POST',
      path: '/internal/admin/apps/:appId/flags',
      description: 'Create a feature flag definition for an app',
      auth: keyedAuth,
      body: {
        key: 'string (required, max 80)',
        description: 'string (optional, max 500)',
        default_state: 'boolean (required)',
      },
      response: { 200: 'Updated app summary object', '401/403': authFailures },
    },
    {
      method: 'PATCH',
      path: '/internal/admin/apps/:appId/flags/:flagId',
      description: 'Update a feature flag definition',
      auth: keyedAuth,
      body: {
        key: 'string (required, max 80)',
        description: 'string (optional, max 500)',
        default_state: 'boolean (required)',
      },
      response: { 200: 'Updated app summary object', '401/403': authFailures },
    },
    {
      method: 'DELETE',
      path: '/internal/admin/apps/:appId/flags/:flagId',
      description: 'Delete a feature flag definition and cascading flag values/overrides',
      auth: keyedAuth,
      response: { 200: 'Updated app summary object', '401/403': authFailures },
    },
    {
      method: 'POST',
      path: '/internal/admin/apps/:appId/kill-switches',
      description: 'Create a kill switch version rule for an app',
      auth: keyedAuth,
      body: {
        name: 'string (optional, max 120)',
        platform: 'both | platform key',
        type: 'hard | soft | info | maintenance',
        version_field: 'versionName | versionCode | buildNumber',
        operator: 'lt | lte | eq | gte | gt | range',
        version_value: 'string (required, max 80)',
        version_max: 'string (optional, max 80; required for range)',
        version_scheme: 'semver | integer | date | custom',
        latest_version: 'string (optional, max 80)',
        active: 'boolean (required)',
        priority: 'number (required, 0-1000)',
        cache_ttl: 'number (optional, 60-86400)',
      },
      response: { 200: 'Updated app summary object', '401/403': authFailures },
    },
    {
      method: 'PATCH',
      path: '/internal/admin/apps/:appId/kill-switches/:killSwitchId',
      description: 'Update a kill switch version rule',
      auth: keyedAuth,
      body: {
        name: 'string (optional, max 120)',
        platform: 'both | platform key',
        type: 'hard | soft | info | maintenance',
        version_field: 'versionName | versionCode | buildNumber',
        operator: 'lt | lte | eq | gte | gt | range',
        version_value: 'string (required, max 80)',
        version_max: 'string (optional, max 80; required for range)',
        version_scheme: 'semver | integer | date | custom',
        latest_version: 'string (optional, max 80)',
        active: 'boolean (required)',
        priority: 'number (required, 0-1000)',
        cache_ttl: 'number (optional, 60-86400)',
      },
      response: { 200: 'Updated app summary object', '401/403': authFailures },
    },
    {
      method: 'DELETE',
      path: '/internal/admin/apps/:appId/kill-switches/:killSwitchId',
      description: 'Delete a kill switch version rule',
      auth: keyedAuth,
      response: { 200: 'Updated app summary object', '401/403': authFailures },
    },
    {
      method: 'GET',
      path: '/internal/admin/search',
      description: 'Search organisations, teams, and users',
      auth: adminAuth,
      query: { q: 'string (optional)' },
      response: { 200: 'Search result array for organisations, teams, and users', '401/403': authFailures },
    },
  ];
}
