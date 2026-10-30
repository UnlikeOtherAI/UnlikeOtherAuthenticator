// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountExpiryPanel } from './AccountExpiryPanel';
import type { UserSummary } from './types';

const mocks = vi.hoisted(() => ({ review: vi.fn(), update: vi.fn(), confirm: vi.fn() }));
vi.mock('../../services/admin-service', () => ({ adminService: {
  reviewAccountRenewal: mocks.review, setUserExpiry: mocks.update,
} }));
vi.mock('../shell/admin-ui', () => ({ useAdminUi: () => ({ confirm: mocks.confirm }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const expired: UserSummary = {
  id: 'user-1', name: 'Reviewer', email: 'reviewer@example.com', domains: [], twofa: false,
  lastLogin: 'Never', status: 'expired', method: 'email', created: '2026-10-01',
  accountExpiresAt: '2026-10-29T12:00:00.000Z',
  accountRenewalRequest: { id: 'request-1', status: 'pending', requestedAt: '2026-10-30T12:00:00.000Z',
    reviewedAt: null, approvedUntil: null },
};

function mount(user = expired) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AccountExpiryPanel user={user} /></QueryClientProvider>);
}

it('approves a pending request only with a new future date', async () => {
  mocks.review.mockResolvedValue({ userId: 'user-1', status: 'approved' });
  mount();
  const approve = screen.getByRole('button', { name: 'Approve renewal' });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  const date = new Date(Date.now() + 7 * 86400000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  fireEvent.change(screen.getByLabelText('New expiry date and time'), { target: { value: local } });
  expect((approve as HTMLButtonElement).disabled).toBe(false);
  await userEvent.setup().click(approve);
  await waitFor(() => expect(mocks.review).toHaveBeenCalledWith('request-1', 'approve', new Date(local).toISOString()));
  expect(mocks.update).not.toHaveBeenCalled();
});
