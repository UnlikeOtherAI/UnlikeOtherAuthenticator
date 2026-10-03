// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainOverviewTab } from './DomainOverviewTab';
import type { Domain } from './types';
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), rotate: vi.fn(), update: vi.fn() }));
vi.mock('../shell/admin-ui', () => ({ useAdminUi: () => ({ confirm: mocks.confirm }) }));
vi.mock('../../services/admin-service', () => ({ adminService: { rotateDomainSecret: mocks.rotate, updateDomain: mocks.update } }));
const domain: Domain = { id: 'example.com/app', name: 'example.com/app', label: 'Example', secretAge: '1 day', secretOld: false,
  users: 2, orgs: 1, status: 'active', twoFaPolicy: 'optional', allowedEmailDomains: [], allowedEmails: [],
  allowedRedirectUrls: [], created: '2026-10-01', hash: 'prefix…' };
afterEach(cleanup);
beforeEach(() => { mocks.confirm.mockReset(); mocks.rotate.mockReset().mockResolvedValue({ delivery_mode: 'email', email_dispatched: true }); });
function mount(section: 'overview' | 'credentials') {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><DomainOverviewTab domain={domain} section={section} counts={{ organisations: 1, teams: 3, users: 2 }} /></MemoryRouter></QueryClientProvider>);
}
describe('service identity and credentials', () => {
  it('links directory counts and keeps credential controls in their own tab', () => {
    mount('overview');
    expect(screen.getByRole('link', { name: 'View 3 teams' }).getAttribute('href')).toBe('/?tab=teams');
    expect(screen.queryByRole('button', { name: /Rotate/ })).toBeNull();
    expect(screen.getByDisplayValue('Example')).toBeTruthy();
  });
  it('keeps email and one-time reveal as distinct confirmed operations for exact service identifiers', async () => {
    mount('credentials');
    await userEvent.click(screen.getByRole('button', { name: 'Rotate and email claim link' }));
    expect(mocks.rotate).not.toHaveBeenCalled();
    await mocks.confirm.mock.calls[0]?.[2]();
    await waitFor(() => expect(mocks.rotate).toHaveBeenCalledWith('example.com/app', 'email'));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rotate and reveal once' }));
    await mocks.confirm.mock.calls[1]?.[2]();
    await waitFor(() => expect(mocks.rotate).toHaveBeenCalledWith('example.com/app', 'reveal'));
  });
});
