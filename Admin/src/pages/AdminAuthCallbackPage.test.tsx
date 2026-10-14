// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminAuthCallbackPage } from './AdminAuthCallbackPage';
import { AdminSessionProvider } from '../features/auth/admin-session';
import { exchangeAdminAuthorizationCode } from '../features/auth/admin-oauth';
vi.mock('../features/auth/admin-oauth', () => ({
  exchangeAdminAuthorizationCode: vi.fn(),
  clearPendingAdminLogin: vi.fn(),
  readPendingAdminLogin: () => ({
    codeVerifier: 'pkce',
    returnTo: '/users',
    configUrl: 'config',
    redirectUrl: 'callback',
  }),
}));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it('exchanges one code under StrictMode and reaches the stored return destination', async () => {
  vi.mocked(exchangeAdminAuthorizationCode).mockResolvedValue({
    access_token: 'synthetic',
    expires_in: 1800,
    token_type: 'Bearer',
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ adminUser: { email: 'operator@example.test' } })),
      ),
  );
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/auth/callback?code=one-use']}>
        <AdminSessionProvider>
          <Routes>
            <Route path="/auth/callback" element={<AdminAuthCallbackPage />} />
            <Route path="/users" element={<p>Returned to users</p>} />
          </Routes>
        </AdminSessionProvider>
      </MemoryRouter>
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByText('Returned to users')).toBeTruthy());
  expect(exchangeAdminAuthorizationCode).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves a validated existing session when revisiting the callback route', async () => {
  sessionStorage.setItem(
    'uoa-admin-session',
    JSON.stringify({ accessToken: 'existing-synthetic', expiresAt: Date.now() + 60000 }),
  );
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ adminUser: { email: 'operator@example.test' } })),
      ),
  );
  render(
    <MemoryRouter initialEntries={['/auth/callback']}>
      <AdminSessionProvider>
        <Routes>
          <Route path="/auth/callback" element={<AdminAuthCallbackPage />} />
          <Route path="/dashboard" element={<p>Existing administrator</p>} />
        </Routes>
      </AdminSessionProvider>
    </MemoryRouter>,
  );
  expect(await screen.findByText('Existing administrator')).toBeTruthy();
  expect(exchangeAdminAuthorizationCode).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('uoa-admin-session')).toContain('existing-synthetic');
});
