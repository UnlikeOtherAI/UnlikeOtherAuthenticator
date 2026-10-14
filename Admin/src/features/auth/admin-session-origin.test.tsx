// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminSessionProvider } from './admin-session';

vi.mock('../../config/env', () => ({
  adminEnv: { apiBaseUrl: 'https://other.example.test', bypassAuth: false },
}));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('never sends stored bearer credentials to a misconfigured cross-origin bootstrap', async () => {
  const stored = JSON.stringify({ accessToken: 'synthetic-admin', expiresAt: Date.now() + 60000 });
  sessionStorage.setItem('uoa-admin-session', stored);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<AdminSessionProvider><p>Public content</p></AdminSessionProvider>);
  await act(async () => { await Promise.resolve(); });
  expect(fetch).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('uoa-admin-session')).toBe(stored);
});
