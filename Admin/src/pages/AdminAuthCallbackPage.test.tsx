// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { AdminAuthCallbackPage } from './AdminAuthCallbackPage';

vi.mock('../features/auth/admin-session', () => ({
  useAdminSession: () => ({ isAuthenticated: true }),
  useAdminSessionActions: () => ({ completeSignIn: vi.fn(), clearFailedSignIn: vi.fn() }),
}));

afterEach(() => { cleanup(); sessionStorage.clear(); });

function ReviewLocation() {
  const location = useLocation();
  return <p>{location.pathname + location.search}</p>;
}

it('returns an authenticated administrator to the renewal review link', async () => {
  sessionStorage.setItem('uoa-admin-pending-login', JSON.stringify({
    codeVerifier: 'verifier', configUrl: 'https://example.com/config',
    redirectUrl: 'https://example.com/admin/auth/callback',
    returnTo: '/users/user-1?tab=security', createdAt: Date.now(),
  }));
  render(<MemoryRouter initialEntries={['/auth/callback?code=one-use-code']}><Routes>
    <Route path="/auth/callback" element={<AdminAuthCallbackPage />} />
    <Route path="/users/user-1" element={<ReviewLocation />} />
  </Routes></MemoryRouter>);
  expect(await screen.findByText('/users/user-1?tab=security')).toBeTruthy();
  expect(sessionStorage.getItem('uoa-admin-pending-login')).toBeNull();
});
