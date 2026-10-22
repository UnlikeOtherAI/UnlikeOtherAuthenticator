// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../services/api-client';
import { SignupFunnelPage } from './SignupFunnelPage';

const mocks = vi.hoisted(() => ({ isError: false, error: null as unknown, refetch: vi.fn(), filters: [] as unknown[] }));
const summary = {
  from: '2026-10-21',
  to: '2026-10-22',
  domain: null,
  domains: ['hugo.example', 'other.example'],
  totals: [
    { step: 'flow_started', outcome: 'shown', count: 40 },
    { step: 'register_submitted', outcome: 'valid_email', count: 20 },
    { step: 'registration_email', outcome: 'verification_sent', count: 18 },
    { step: 'registration_email', outcome: 'verification_failed', count: 2 },
    { step: 'email_link_opened', outcome: 'valid_set_password', count: 10 },
    { step: 'email_link_opened', outcome: 'expired', count: 4 },
  ],
  days: [
    { day: '2026-10-21', step: 'flow_started', outcome: 'shown', count: 15 },
    { day: '2026-10-22', step: 'flow_started', outcome: 'shown', count: 25 },
    { day: '2026-10-22', step: 'email_link_opened', outcome: 'expired', count: 4 },
  ],
};
vi.mock('../features/admin/auth-funnel-queries', () => ({
  useAuthFunnelQuery: (filters: unknown) => {
    mocks.filters.push(filters);
    return { data: mocks.isError ? undefined : summary, error: mocks.error, isError: mocks.isError, isLoading: false, refetch: mocks.refetch };
  },
}));
afterEach(cleanup);

function stepRow(label: string): HTMLElement {
  const row = screen.getByText(label, { selector: 'p' }).closest('tr');
  if (!row) throw new Error(`No step row for ${label}`);
  return row;
}
beforeEach(() => { mocks.isError = false; mocks.error = null; mocks.refetch.mockReset(); mocks.filters = []; });

it('shows how far visitors got, with failures broken out per step', () => {
  render(<MemoryRouter initialEntries={['/signup-funnel']}><SignupFunnelPage /></MemoryRouter>);
  const linkRow = stepRow('Email link opened');
  expect(within(linkRow).getByText('10')).toBeTruthy();
  expect(within(linkRow).getByText('25%')).toBeTruthy();
  expect(within(linkRow).getByText('Expired: 4')).toBeTruthy();
  const emailRow = stepRow('Registration email');
  expect(within(emailRow).getByText('Verification: send failed: 2')).toBeTruthy();
  expect(screen.getByText('2026-10-22')).toBeTruthy();
});

it('keeps the period and service in the request filters', async () => {
  render(<MemoryRouter initialEntries={['/signup-funnel?from=2026-10-01&to=2026-10-22']}><SignupFunnelPage /></MemoryRouter>);
  await userEvent.setup().selectOptions(screen.getByLabelText('Service'), 'hugo.example');
  expect(mocks.filters.at(-1)).toEqual({ from: '2026-10-01', to: '2026-10-22', domain: 'hugo.example' });
});

it('offers a retry instead of an empty funnel when loading fails', async () => {
  mocks.isError = true;
  render(<MemoryRouter><SignupFunnelPage /></MemoryRouter>);
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByText('No sign-in activity was recorded for these filters.')).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

it('explains an impossible period instead of offering a retry that cannot help', () => {
  mocks.isError = true;
  mocks.error = new ApiRequestError(400, 'INVALID_DATE_RANGE');
  render(<MemoryRouter initialEntries={['/signup-funnel?from=2026-10-22&to=2026-10-01']}><SignupFunnelPage /></MemoryRouter>);
  expect(screen.getByText('Choose a From day on or before To, at most 366 days apart.')).toBeTruthy();
});
