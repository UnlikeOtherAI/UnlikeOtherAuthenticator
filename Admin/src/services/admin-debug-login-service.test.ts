// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminConfigUrl } from '../features/auth/admin-oauth';
import { logoutAdminSession, parseAdminDebugLogin } from './admin-debug-login-service';
describe('admin debug import contract', () => {
  afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });
  const token = 'a'.repeat(43);
  it('accepts a bare code and exactly the same admin destination JSON', () => {
    expect(parseAdminDebugLogin(` ${token} `)).toBe(token);
    expect(parseAdminDebugLogin(JSON.stringify({ url: new URL('/admin/login', adminConfigUrl()).toString(), token }))).toBe(token);
  });
  it('rejects additional fields, malformed codes and other products/environments', () => {
    for (const input of ['invalid', JSON.stringify({ url: 'https://other.example/admin/login', token }),
      JSON.stringify({ url: new URL('/admin/login', adminConfigUrl()).toString(), token, bearer: 'secret' })]) {
      expect(() => parseAdminDebugLogin(input)).toThrow();
    }
  });
  it('retains the exact logout bearer on transport failure inside the expiry margin', async () => {
    const stored = JSON.stringify({ accessToken: 'margin-bearer', expiresAt: Date.now() + 3000 });
    sessionStorage.setItem('uoa-admin-session', stored);
    const fetch = vi.fn().mockRejectedValue(new Error('network')); vi.stubGlobal('fetch', fetch);
    await expect(logoutAdminSession('margin-bearer')).rejects.toThrow('network');
    expect(sessionStorage.getItem('uoa-admin-session')).toBe(stored);
    const options = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer margin-bearer');
  });
});
