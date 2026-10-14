// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { DomainDetailPage } from './DomainDetailPage';

vi.mock('../features/admin/useDirectoryNavigation', () => ({
  useDirectoryNavigation: () => ({ goBack: vi.fn() }),
}));
vi.mock('../features/shell/admin-ui', () => ({ useAdminUi: () => ({ confirm: vi.fn() }) }));
vi.mock('../features/admin/admin-queries', () => ({
  useDomainQuery: (name: string) => ({
    data: {
      domain: {
        name,
        id: name,
        label: 'Shared label',
        status: 'active',
        twoFaPolicy: 'optional',
        allowedEmailDomains: [],
        allowedEmails: [],
        allowedRedirectUrls: [],
      },
      organisations: [],
      teams: [],
      users: [],
    },
    isLoading: false,
  }),
  useDomainEmailQuery: () => ({ data: { config: null }, isLoading: false }),
  useDomainJwksQuery: () => ({ data: [], isLoading: false }),
}));
afterEach(cleanup);

function mount(tab: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/domains/a.example?tab=${tab}`]}>
        <Link to={`/domains/b.example?tab=${tab}`}>Switch website</Link>
        <Routes>
          <Route path="/domains/:domainId" element={<DomainDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('does not carry email drafts into another domain with the same friendly label', async () => {
  mount('email');
  await userEvent.type(screen.getByPlaceholderText('mail.example.com'), 'mail.a.example');
  await userEvent.click(screen.getByRole('link', { name: 'Switch website' }));
  expect(screen.getByPlaceholderText('mail.example.com')).toHaveProperty('value', '');
});

it('closes a domain-bound public-key editor instead of retargeting it', async () => {
  mount('keys');
  await userEvent.click(screen.getByRole('button', { name: 'Add signing key', exact: true }));
  await userEvent.type(screen.getByRole('textbox'), 'old-domain-public-key-draft');
  await userEvent.click(screen.getByRole('link', { name: 'Switch website' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
