// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutomaticMembershipSection } from './AutomaticMembershipSection';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), control: vi.fn(), getRules: vi.fn(), getTeams: vi.fn(),
}));

vi.mock('../../services/admin-service', () => ({
  adminService: {
    getAutomaticMembership: (...args: unknown[]) => mocks.getRules(...args),
    getAutomaticMembershipTeams: (...args: unknown[]) => mocks.getTeams(...args),
    controlAutomaticMembership: (...args: unknown[]) => mocks.control(...args),
  },
}));
vi.mock('../shell/admin-ui', () => ({ useAdminUi: () => ({ confirm: mocks.confirm }) }));

function renderSection() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AutomaticMembershipSection orgId="org-1" scope="organisation" /></QueryClientProvider>);
}

describe('AutomaticMembershipSection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getRules.mockResolvedValue({ rules: [{ id: 'rule-1', domain: 'acme.example', scope: 'organisation', external_team_id: null, state: 'verified', notification_email: null, team_ids: ['team-1'], dns: { record_name: '_uoa.acme.example', record_value: 'token' }, last_check_at: null, last_check_error: null, verification_expires_at: null, backfill: { status: 'queued', processed: 0, granted: 0, failed: 0, error: null } }], audit: [] });
    mocks.getTeams.mockResolvedValue({ teams: [{ external_team_id: 'team-1', name: 'Engineering' }] });
    mocks.control.mockResolvedValue({ rules: [] });
  });
  afterEach(cleanup);

  it('renders persistent DNS guidance and requires confirmation before activation/backfill', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByText('Automatic team access after sign-in')).toBeTruthy();
    expect(screen.getByText('_uoa.acme.example')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Activate & backfill' }));
    expect(mocks.control).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledWith(
      'Activate automatic access?', expect.stringContaining('safe, resumable backfill'), expect.any(Function),
    );
  });
});
