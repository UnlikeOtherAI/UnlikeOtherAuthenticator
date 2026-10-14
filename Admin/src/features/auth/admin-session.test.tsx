// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminSessionProvider, useAdminSession, useAdminSessionActions } from './admin-session';
import { logoutAdminSession } from '../../services/admin-debug-login-service';
import { ApiRequestError } from '../../services/api-client';
vi.mock('../../services/admin-debug-login-service', () => ({ logoutAdminSession: vi.fn() }));
function Actions() {
  const { completeSignIn, signOut } = useAdminSessionActions();
  const session = useAdminSession();
  return (
    <>
      <span>
        {session.isAuthenticated ? 'authenticated' : session.isLoading ? 'loading' : 'signed out'}
      </span>
      <button onClick={() => void completeSignIn('new-bearer', 1800).catch(() => {})}>Login</button>
      <button onClick={() => void signOut().catch(() => {})}>Logout</button>
    </>
  );
}
describe('admin session ownership', () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });
  it('persists the new bearer only after server validation succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    render(
      <AdminSessionProvider>
        <Actions />
      </AdminSessionProvider>,
    );
    await userEvent.click(screen.getByText('Login'));
    expect(sessionStorage.getItem('uoa-admin-session')).toBeNull();
  });
  it('revokes the live source during the proactive five-second expiry margin', async () => {
    render(
      <AdminSessionProvider>
        <Actions />
      </AdminSessionProvider>,
    );
    sessionStorage.setItem(
      'uoa-admin-session',
      JSON.stringify({ accessToken: 'margin-bearer', expiresAt: Date.now() + 3000 }),
    );
    vi.mocked(logoutAdminSession).mockResolvedValue();
    await userEvent.click(screen.getByText('Logout'));
    expect(logoutAdminSession).toHaveBeenCalledWith('margin-bearer');
    expect(sessionStorage.getItem('uoa-admin-session')).toBeNull();
  });
  it('retains the source on failed server writes but clears confirmed invalid authority', async () => {
    render(
      <AdminSessionProvider>
        <Actions />
      </AdminSessionProvider>,
    );
    const value = JSON.stringify({ accessToken: 'source-bearer', expiresAt: Date.now() + 60_000 });
    sessionStorage.setItem('uoa-admin-session', value);
    vi.mocked(logoutAdminSession).mockRejectedValueOnce(new Error('network'));
    await userEvent.click(screen.getByText('Logout'));
    expect(sessionStorage.getItem('uoa-admin-session')).toBe(value);
    vi.mocked(logoutAdminSession).mockRejectedValueOnce(new ApiRequestError(401));
    await userEvent.click(screen.getByText('Logout'));
    expect(sessionStorage.getItem('uoa-admin-session')).toBeNull();
  });
});

describe('bootstrap recovery and expiry', () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('retains a valid stored session on 503 and recovers without login', async () => {
    const stored = JSON.stringify({ accessToken: 'synthetic', expiresAt: Date.now() + 60000 });
    sessionStorage.setItem('uoa-admin-session', stored);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 503 }))
        .mockResolvedValue(
          new Response(JSON.stringify({ adminUser: { email: 'operator@example.test' } })),
        ),
    );
    render(
      <AdminSessionProvider>
        <Actions />
      </AdminSessionProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('uoa-admin-session')).toBe(stored);
    await waitFor(() => expect(screen.getByText('authenticated')).toBeTruthy(), { timeout: 2000 });
  });
  it('clears live React state when stored credentials expire', async () => {
    sessionStorage.setItem(
      'uoa-admin-session',
      JSON.stringify({ accessToken: 'synthetic', expiresAt: Date.now() + 60000 }),
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
      <AdminSessionProvider>
        <Actions />
      </AdminSessionProvider>,
    );
    await waitFor(() => expect(screen.getByText('authenticated')).toBeTruthy());
    sessionStorage.setItem(
      'uoa-admin-session',
      JSON.stringify({ accessToken: 'synthetic', expiresAt: Date.now() - 1 }),
    );
    await waitFor(() => expect(screen.getByText('signed out')).toBeTruthy(), { timeout: 2000 });
    expect(sessionStorage.getItem('uoa-admin-session')).toBeNull();
  });
});
