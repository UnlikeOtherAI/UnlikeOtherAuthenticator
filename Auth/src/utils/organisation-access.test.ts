// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('./api.js', () => ({ request }));
beforeEach(() => { request.mockReset(); vi.resetModules(); window.history.replaceState(null, '', '/auth/organisation-access'); });
const settings = {
  ok: true, org: { id: 'org-one', name: 'Acme' }, client_domain: 'product.example', csrf_token: 'csrf',
  connections: [], domains: [], teams: [{id:'team-one',name:'Research'}], policy: { revision: 1, enforcement: 'off', session_max_age_seconds: 28800, reauth_mode: 'detect_only', jit_enabled:false, default_team_id:null, allow_unverified_contractors:false, discovery_enabled:false, group_mappings:[] },
  readiness: { activation_allowed: false, enforcement_allowed: false, blockers: [] }, presets: [], scim: { enabled: false },
};
describe('organisation access browser boundary', () => {
  it('removes the one-use fragment before exchange and deduplicates StrictMode replay', async () => {
    window.history.replaceState(null, '', '/auth/organisation-access#continuation=one-use');
    request.mockImplementation(async (_method, path) => {
      expect(window.location.hash).toBe('');
      return { ok: true, data: path.endsWith('/exchange') ? { ok: true } : settings };
    });
    const { openOrganisationAccess } = await import('./organisation-access.js');
    const [first, second] = await Promise.all([openOrganisationAccess(), openOrganisationAccess()]);
    expect(first.org.id).toBe('org-one'); expect(second).toBe(first);
    expect(request.mock.calls.filter((call) => call[1].endsWith('/exchange'))).toHaveLength(1);
    expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0);
  });
  it('uses scoped same-origin routes and the server CSRF value without a browser bearer', async () => {
    request.mockResolvedValue({ ok: true, data: { ok: true } });
    const { accessMutation, decodeSettings } = await import('./organisation-access.js');
    await accessMutation(decodeSettings(settings), 'POST', '/connections/c/state', { revision: 7, status: 'active' });
    expect(request).toHaveBeenCalledWith('POST', '/auth/organisation-access/sso/connections/c/state', {
      body: { revision: 7, status: 'active' }, csrfToken: 'csrf',
    });
  });
  it('rejects malformed hydration and cross-origin or unrelated test destinations', async () => {
    const { decodeSettings, trustedTestUrl } = await import('./organisation-access.js');
    expect(() => decodeSettings({ ...settings, csrf_token: undefined })).toThrow();
    expect(() => decodeSettings({ ...settings, policy: { ...settings.policy, reauth_mode: 'guess' } })).toThrow();
    expect(() => decodeSettings({ ...settings, policy: { ...settings.policy, group_mappings: [{connection_id:'connection-one',external_group_id:'group',team_id:'team-one',team_role:'owner'}] } })).toThrow();
    expect(() => decodeSettings({ ...settings, teams: [{id:'team-one',name:null}] })).toThrow();
    const connection = { id: 'c', preset: 'entra', protocol: 'oidc', display_name: 'Corporate', status: 'draft',
      revision: 1, configuration: {}, secret_configured: false, tested_revision: null };
    expect(() => decodeSettings({ ...settings, connections: [{ ...connection, callback_url: 'https://evil.example/callback' }] })).toThrow();
    expect(() => decodeSettings({ ...settings, connections: [{ ...connection, last_test: { status: 'invented', code: null, at: 'today' } }] })).toThrow();
    expect(() => trustedTestUrl('https://evil.example/sso/c/start')).toThrow();
    expect(() => trustedTestUrl('/auth/token')).toThrow();
    expect(trustedTestUrl('/sso/c/start')).toContain('/sso/c/start');
  });
  it('allows a transient bootstrap failure to retry without caching a rejection', async () => {
    request.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true, data: settings });
    const { openOrganisationAccess } = await import('./organisation-access.js');
    await expect(openOrganisationAccess()).rejects.toMatchObject({ status: 503 });
    await expect(openOrganisationAccess()).resolves.toMatchObject({ org: settings.org });
  });
  it('recovers a lost exchange response through the cookie without replaying the continuation', async () => {
    window.history.replaceState(null, '', '/auth/organisation-access#continuation=one-use');
    request.mockResolvedValueOnce({ ok: false, status: 0 }).mockResolvedValueOnce({ ok: true, data: settings });
    const { openOrganisationAccess } = await import('./organisation-access.js');
    await expect(openOrganisationAccess()).resolves.toMatchObject({ org: settings.org });
    expect(request.mock.calls.filter((call) => call[1].endsWith('/exchange'))).toHaveLength(1);
  });
  it('keeps failures retryable and does not reinterpret an outage as successful authorization', async () => {
    request.mockResolvedValue({ ok: false, status: 503 });
    const { loadOrganisationAccess } = await import('./organisation-access.js');
    await expect(loadOrganisationAccess()).rejects.toMatchObject({ status: 503 });
  });
});
