// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrganisationsPage } from './OrganisationsPage';
import { OrganisationDetailPage } from './OrganisationDetailPage';
import { UsersPage } from './UsersPage';
import { TeamsPage } from './TeamsPage';
import { TeamTable } from '../features/admin/TeamTable';

const mocks = vi.hoisted(() => ({ create: vi.fn(), refetch: vi.fn(), isError: false, createError: false }));
const organisation = {
  id: 'org-1', name: 'Acme', slug: 'acme', created: '2026-01-01',
  owner: { id: 'user-1', name: null, email: 'owner@example.com' },
  twoFaPolicy: 'inherit' as const, allowedEmails: [], allowedEmailDomains: [],
  teams: [{ id: 'team-1', orgId: 'org-1', name: 'Engineering', description: 'Build', members: 1, isDefault: true, allowedEmails: [], allowedEmailDomains: [] }],
  members: [], preapprovedMembers: [],
};
vi.mock('../features/admin/admin-queries', () => ({
  useOrganisationsQuery: () => ({ data: [organisation], isLoading: false, isError: mocks.isError, refetch: mocks.refetch }),
  useOrganisationQuery: () => ({ data: organisation, isLoading: false, isError: false }),
  useCreateOrganisationMutation: () => ({ mutateAsync: mocks.create, isPending: false, isError: mocks.createError }),
  useUsersQuery: () => ({ data: [{ id: 'user-1', name: 'Alex', email: 'alex@example.com', domains: ['example.com'], method: 'email', twofa: true, lastLogin: '2026-10-03', status: 'active' }], isLoading: false }),
  useDomainsQuery: () => ({ data: [{ name: 'example.com', label: 'Example' }] }),
  useUserAvatarQuery: () => ({ data: undefined }),
  useTeamsQuery: () => ({ data: [{ ...organisation.teams[0], orgName: 'Acme' }], isLoading: false }),
  useTeamAvatarQuery: () => ({ data: undefined }),
}));
vi.mock('../features/shell/admin-ui', () => ({ useAdminUi: () => ({ confirm: vi.fn() }) }));

function mount(path = '/organisations') {
  const router = createMemoryRouter([
    { path: '/organisations', element: <OrganisationsPage /> },
    { path: '/organisations/:orgId', element: <OrganisationDetailPage /> },
    { path: '/users', element: <UsersPage /> },
    { path: '/teams', element: <TeamsPage /> },
    { path: '/users/:id', element: <p>User record</p> },
  ], { initialEntries: [path] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

afterEach(cleanup);
beforeEach(() => { mocks.create.mockReset(); mocks.refetch.mockReset(); mocks.isError = false; mocks.createError = false; });

describe('Directory navigation and truthful controls', () => {
  it('filters organisations and preserves the search when returning from a canonical record', async () => {
    const user = userEvent.setup();
    const router = mount();
    await user.type(screen.getByRole('searchbox', { name: 'Search organisations' }), 'missing');
    expect(screen.getByText('No organisations match this search.')).toBeTruthy();
    expect(router.state.location.search).toContain('q=missing');
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'Acme');
    const link = screen.getByRole('link', { name: 'Acme' });
    expect(link.getAttribute('href')).toBe('/organisations/org-1');
    await user.click(link);
    expect(router.state.location.pathname).toBe('/organisations/org-1');
    expect(screen.getByRole('button', { name: 'Members' })).toBeTruthy();
    expect(screen.queryByText('Login access whitelist')).toBeNull();
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(router.state.location.search).toBe('?q=Acme');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Acme');
  });

  it('uses an owner link without falling through into the organisation row', async () => {
    const user = userEvent.setup();
    const router = mount();
    await user.click(screen.getByRole('link', { name: 'owner@example.com' }));
    expect(router.state.location.pathname).toBe('/users/user-1');
  });

  it('submits only supported organisation fields and retains inputs after a failure for retry', async () => {
    const user = userEvent.setup();
    mocks.create.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    mount();
    await user.click(screen.getByRole('button', { name: 'New organisation' }));
    expect(screen.queryByLabelText('Description')).toBeNull();
    expect(screen.queryByText('Pre-approved members')).toBeNull();
    await user.type(screen.getByPlaceholderText('Acme Engineering'), 'New org');
    await user.type(screen.getByPlaceholderText('app.example.com'), 'example.com');
    await user.type(screen.getByPlaceholderText('owner@example.com'), 'owner@example.com');
    await user.click(screen.getByRole('button', { name: 'Create Organisation' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith({ name: 'New org', domain: 'example.com', ownerEmail: 'owner@example.com' });
    expect((screen.getByPlaceholderText('Acme Engineering') as HTMLInputElement).value).toBe('New org');
    await user.click(screen.getByRole('button', { name: 'Create Organisation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('shows a retry action instead of an empty directory after query failure', async () => {
    mocks.isError = true;
    mount();
    expect(screen.getByRole('alert')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('No organisations match this search.')).toBeNull();
  });

  it('links both the team and its organisation independently', async () => {
    const router = createMemoryRouter([
      { path: '/', element: <TeamTable teams={[{ ...organisation.teams[0], orgName: 'Acme' }]} showOrganisation /> },
      { path: '/organisations/:orgId', element: <p>Organisation record</p> },
      { path: '/organisations/:orgId/teams/:teamId', element: <p>Team record</p> },
    ]);
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('link', { name: 'Engineering' }).getAttribute('href')).toBe('/organisations/org-1/teams/team-1');
    await userEvent.setup().click(screen.getByRole('link', { name: 'Acme' }));
    expect(router.state.location.pathname).toBe('/organisations/org-1');
  });
  it('restores user and team filters from the URL and exposes native user links', async () => {
    const router = mount('/users?q=missing&domain=example.com');
    expect(screen.getByText('No users match these filters.')).toBeTruthy();
    await userEvent.setup().clear(screen.getByRole('searchbox'));
    expect(screen.getByRole('link', { name: 'Alex' }).getAttribute('href')).toBe('/users/user-1');
    expect(screen.getByText('2FA enabled')).toBeTruthy();
    expect(router.state.location.search).toBe('?domain=example.com');
    cleanup();
    mount('/teams?q=missing');
    expect(screen.getByText('No teams found.')).toBeTruthy();
    await userEvent.setup().clear(screen.getByRole('searchbox'));
    expect(screen.getByRole('link', { name: 'Engineering' })).toBeTruthy();
  });

});
