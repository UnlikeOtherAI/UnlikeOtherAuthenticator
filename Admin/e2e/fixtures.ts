import type { Page } from '@playwright/test';
import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';
import type { NativeApp } from '../src/schemas/native-app';

export const nativeApp: NativeApp = {
  id: 'native-1', identifier: 'com.example.browser', name: 'Fixture Browser', enabled: true,
  redirect_uris: ['http://127.0.0.1:9000/callback'], scopes: ['openid', 'profile', 'email'],
  methods: ['google', 'email_password'], allow_registration: true, primary_color: '#2563eb',
  background_color: '#ffffff', text_color: '#111827', icon_url: null, revision: 1,
};
const now = '2026-10-03T12:00:00.000Z';
const request = {
  id: 'request-1', domain: 'app.acme.com', status: 'ACCEPTED', contact_email: 'partner@example.test',
  kid: 'fixture-key', jwk_fingerprint: 'fixture-fingerprint', jwks_url: 'https://app.acme.com/jwks.json',
  config_url: 'https://app.acme.com/config', decline_reason: null, reviewed_at: now,
  reviewed_by_email: 'operator@example.test', client_domain_id: 'app.acme.com', submitted_at: now,
  last_seen_at: now, public_jwk: { kty: 'RSA', kid: 'fixture-key' }, config_summary: { verified: true },
  pre_validation_result: { ok: true },
};
const signatures = {
  settings: { enabled: false, policy_revision: 1, retention_days: 90, created_at: now, updated_at: now },
  agreements: [{ id: 'agreement-1', title: 'Fixture agreement', description: 'Terms', display_order: 1,
    required_for_access: true, created_at: now, updated_at: now, versions: [] }], audit_events: [],
};

/** All browser API calls terminate here. Unexpected writes fail closed. */
export async function installFixtures(page: Page) {
  const data = structuredClone(mockAdminData);
  data.domains.forEach((domain) => { domain.id = domain.name; });
  const teams = data.organisations.flatMap((org) => org.teams.map((team) => ({ ...team, orgName: org.name })));
  const native = structuredClone(nativeApp);
  const unexpected: string[] = [];
  const errors: string[] = [];
  let nativeFailures = 0;
  let nativeWrites = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    unexpected.push(`External request ${url.origin}`);
    return route.abort();
  });
  await page.route('**/internal/admin/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.replace('/internal/admin', ''));
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET') {
      if (path === '/native-apps/native-1' && req.method() === 'PUT') {
        nativeWrites += 1;
        if (nativeFailures > 0) { nativeFailures -= 1; return json({ error: 'Fixture rejected save' }, 503); }
        Object.assign(native, req.postDataJSON(), { revision: native.revision + 1 });
        return json(native);
      }
      unexpected.push(`${req.method()} ${path}`);
      return json({ error: 'Unexpected fixture write' }, 500);
    }
    if (path.endsWith('/avatar')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#4f46e5"/></svg>' });
    if (path === '/dashboard') return json(data);
    if (path === '/domains') return json(data.domains);
    if (path.startsWith('/domains/')) {
      if (path.endsWith('/email')) return json({ config: null, liveStatus: null, dnsRecords: null, adminCredentialsConfigured: false });
      if (path.endsWith('/jwks')) return json([]);
      if (path.endsWith('/signatures/records')) return json({ data: [], next_cursor: null });
      if (path.endsWith('/signatures')) return json(signatures);
      const domain = data.domains.find((item) => path === `/domains/${item.name}`);
      if (domain) return json({ domain, organisations: data.organisations.slice(0, 2), teams: teams.filter((team) => team.orgId === 'o1'), users: data.users });
    }
    if (path === '/organisations') return json(data.organisations);
    const orgMatch = /^\/organisations\/([^/]+)(?:\/teams\/([^/]+))?$/.exec(path);
    if (orgMatch) {
      const org = data.organisations.find((item) => item.id === orgMatch[1]);
      return json(orgMatch[2] ? { org, team: org?.teams.find((item) => item.id === orgMatch[2]) } : org);
    }
    if (path === '/teams') return json(teams);
    if (path === '/users') return json(data.users);
    if (path.startsWith('/users/')) return json(data.users.find((user) => path === `/users/${user.id}`));
    if (path === '/logs') return json(data.logs.map((log) => ({ ...log, userId: 'u101' })));
    if (path === '/handshake-errors') return json(data.handshakeErrors);
    if (path === '/settings') return json({ apps: data.apps.map((app) => ({ ...app, audienceGroups: [] })), bans: data.bans });
    if (path === '/native-apps') return json([native]);
    if (path === '/integration-requests') return json(url.searchParams.get('status') === 'PENDING' ? [] : [request]);
    if (path === '/integration-requests/request-1') return json(request);
    if (path === '/confidential-delegations') return json([]);
    if (path === '/api-keys') return json([]);
    if (path === '/superusers') return json([{ userId: 'u101', email: 'alice@acme.com', name: 'Alice Chen', createdAt: now }]);
    if (path === '/billing/services') return json([{ id: 'billing-1', name: 'Fixture product', identifier: 'fixture', active: true,
      tariffs: [], assignments: [], app_keys: [], adjustments: [], stripe_catalogs: [], stripe_subscriptions: [], created_at: now, updated_at: now }]);
    if (path.startsWith('/billing/')) return json([]);
    if (path === '/bans') return json([...data.bans.emails, ...data.bans.ips]);
    if (path === '/search') return json([{ type: 'user', user: data.users[0] }]);
    unexpected.push(`GET ${path}`);
    return json({ error: 'Missing fixture' }, 404);
  });
  return { unexpected, errors, native, failNextNativeSave: () => { nativeFailures = 1; }, nativeWrites: () => nativeWrites };
}
