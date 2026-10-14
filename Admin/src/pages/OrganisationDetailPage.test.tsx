// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { Organisation, OrganisationMember } from '../features/admin/types';
import { OrganisationDetailPage } from './OrganisationDetailPage';

const state = vi.hoisted(() => ({ organisation: undefined as Organisation | undefined }));
vi.mock('../features/admin/admin-queries', () => ({
  useOrganisationQuery: () => ({ data: state.organisation }),
  useUserAvatarQuery: () => ({ data: undefined }),
}));
afterEach(cleanup);

function member(
  id: string,
  status: OrganisationMember['status'],
  membershipStatus: OrganisationMember['membershipStatus'],
  role: OrganisationMember['role'] = 'member',
): OrganisationMember {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    status,
    membershipStatus,
    role,
    teams: ['Research'],
    teamRoles: { Research: 'member' },
    twofa: false,
    lastLogin: 'Never',
    method: 'email',
  };
}
function mount(members: OrganisationMember[]) {
  state.organisation = {
    id: 'org-1',
    name: 'Fixture org',
    slug: 'fixture',
    created: '2026-10-14',
    owner: { id: 'owner', name: 'Owner', email: 'owner@example.test' },
    allowedEmails: [],
    allowedEmailDomains: [],
    twoFaPolicy: 'inherit',
    preapprovedMembers: [],
    members,
    teams: [
      {
        id: 'team-1',
        orgId: 'org-1',
        name: 'Research',
        description: '',
        members: 1,
        isDefault: true,
        allowedEmails: [],
        allowedEmailDomains: [],
      },
    ],
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/organisations/org-1?tab=members']}>
        <Routes>
          <Route path="/organisations/:orgId" element={<OrganisationDetailPage />} />
          <Route path="/users/:userId" element={<p>User recovery record</p>} />
          <Route path="/organisations/:orgId/teams/:teamId" element={<p>Team record</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it.each([
  ['removed-account', 'active', 'removed', 'member'],
  ['disabled-account', 'disabled', 'active', 'member'],
  ['paused-member', 'active', 'deactivated', 'admin'],
  ['owner-account', 'active', 'active', 'owner'],
    ['deleted-account', 'deleted', 'removed', 'member'],
    ['banned-account', 'banned', 'deactivated', 'member'],
    ['deleting-account', 'deleting', 'removed', 'member'],
] as const)(
  'keeps account lifecycle and membership independent for %s',
  async (id, account, membership, role) => {
    mount([member(id, account, membership, role)]);
    expect(screen.getByRole('columnheader', { name: 'Account status' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Membership' })).toBeTruthy();
    const row = screen.getByRole('link', { name: id }).closest('tr');
    if (!row) throw new Error('Missing member row');
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]?.textContent).toBe(role);
    expect(cells[2]?.textContent).toBe(account);
    expect(cells[3]?.textContent).toBe(membership);
    expect(within(row).getByRole('link', { name: 'Research' }).getAttribute('href')).toBe(
      '/organisations/org-1/teams/team-1',
    );
    expect(within(row).queryByRole('button')).toBeNull();
    await userEvent.click(within(row).getByRole('link', { name: id }));
    expect(screen.getByText('User recovery record')).toBeTruthy();
  },
);

it('does not invent active membership when an older response omits the field', () => {
  const legacy = member('legacy-account', 'disabled', 'active');
  Reflect.deleteProperty(legacy, 'membershipStatus');
  mount([legacy]);
  const row = screen.getByRole('link', { name: 'legacy-account' }).closest('tr');
  if (!row) throw new Error('Missing member row');
  expect(within(row).getByText('disabled')).toBeTruthy();
  expect(within(row).getByText('Unavailable')).toBeTruthy();
  expect(within(row).queryByText('active')).toBeNull();
});

it('retains an honest empty Members table', () => {
  mount([]);
  expect(screen.getByText('No members found.').getAttribute('colspan')).toBe('6');
});
