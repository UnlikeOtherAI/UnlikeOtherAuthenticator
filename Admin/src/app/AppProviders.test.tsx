// @vitest-environment happy-dom
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from './AppProviders';
import { useAdminSessionActions } from '../features/auth/admin-session';

vi.mock('../services/admin-debug-login-service', () => ({ logoutAdminSession: vi.fn(async () => {}) }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it('clears person-scoped query and mutation caches after confirmed logout', async () => {
  let client: QueryClient | undefined;
  function Probe() {
    client = useQueryClient();
    const { signOut } = useAdminSessionActions();
    return <button onClick={() => void signOut()}>Sign out</button>;
  }
  sessionStorage.setItem('uoa-admin-session', JSON.stringify({ accessToken: 'synthetic', expiresAt: Date.now() + 60000 }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ adminUser: { email: 'operator@example.test' } }))));
  render(<AppProviders><Probe /></AppProviders>);
  client?.setQueryData(['admin', 'private'], { private: 'previous-person-data' });
  client?.getMutationCache().build(client, { mutationFn: async () => undefined });
  await userEvent.click(screen.getByText('Sign out'));
  await waitFor(() => expect(client?.getQueryCache().getAll()).toHaveLength(0));
  expect(client?.getMutationCache().getAll()).toHaveLength(0);
  expect(sessionStorage.getItem('uoa-admin-session')).toBeNull();
});
