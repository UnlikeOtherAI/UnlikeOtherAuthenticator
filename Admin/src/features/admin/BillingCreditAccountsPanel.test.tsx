// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingCreditAccount } from '../../schemas/billing-credits';
import { BillingCreditAccountsPanel } from './BillingCreditAccountsPanel';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  reset: vi.fn(),
}));

const account = {
  id: 'credit-account-1',
  organisation: { id: 'org-1', name: 'Acme Research' },
  team: { id: 'team-1', name: 'Research Lab' },
  mode: 'live' as const,
  remaining_credits: {
    credits: '42875',
    display: '42,875 credits',
    usd_equivalent: { amount: '42.875', currency: 'USD' as const, display: 'US$42.88' },
  },
  updated_at: '2026-07-21T11:00:00.000Z',
  recent_adjustments: [
    {
      id: 'credit-adjustment-1',
      signed_credits: {
        credits: '-125',
        display: '-125 credits',
        usd_equivalent: { amount: '-0.125', currency: 'USD' as const, display: '-US$0.13' },
      },
      reason: 'Reverse duplicate test grant',
      idempotency_key: 'reverse:team-1:2026-07-21',
      created_by: {
        user_id: 'operator-1',
        email: 'operator@example.com',
        admin_domain: 'admin.example.com',
      },
      created_at: '2026-07-21T10:00:00.000Z',
    },
  ],
} satisfies BillingCreditAccount;

vi.mock('./billing-admin-queries', () => ({
  useBillingCreditAccountsQuery: () => ({
    data: [account],
    isError: false,
    isLoading: false,
  }),
  useCreateBillingCreditAdjustmentMutation: () => ({
    error: null,
    isError: false,
    isPending: false,
    mutateAsync: state.create,
    reset: state.reset,
  }),
}));

describe('BillingCreditAccountsPanel', () => {
  beforeEach(() => {
    state.create.mockReset().mockResolvedValue({
      account,
      adjustment: account.recent_adjustments[0],
      replayed: false,
    });
    state.reset.mockReset();
  });

  afterEach(cleanup);

  it('shows exact shared balances and immutable adjustment audit details', () => {
    render(<BillingCreditAccountsPanel />);

    expect(screen.getByRole('heading', { name: 'Team credit accounts' })).toBeTruthy();
    expect(screen.getAllByText('Research Lab').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Acme Research').length).toBeGreaterThan(0);
    expect(screen.getByText('42,875 credits')).toBeTruthy();
    expect(screen.getByText('US$42.88')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('-125 credits')).toBeTruthy();
    expect(screen.getByText('-US$0.13 equivalent')).toBeTruthy();
    expect(screen.getByText('Reverse duplicate test grant')).toBeTruthy();
    expect(screen.getByText('reverse:team-1:2026-07-21')).toBeTruthy();
    expect(screen.getByText('operator@example.com')).toBeTruthy();
  });

  it('posts an exact signed delta and keeps its idempotency key stable', async () => {
    state.create
      .mockRejectedValueOnce(new Error('Temporary network failure'))
      .mockResolvedValueOnce({
        account,
        adjustment: account.recent_adjustments[0],
        replayed: true,
      });
    const user = userEvent.setup();
    render(<BillingCreditAccountsPanel />);

    await user.click(screen.getByRole('button', { name: 'Adjust' }));
    const dialog = screen.getByRole('dialog', { name: 'Adjust team credits' });
    expect(within(dialog).getByText('Live')).toBeTruthy();
    expect(within(dialog).getByText(/1,000 credits = US\$1\.00/)).toBeTruthy();
    expect(within(dialog).getByText('Live customer balance')).toBeTruthy();

    const postButton = within(dialog).getByRole('button', { name: 'Post adjustment' });
    const liveConfirmation = within(dialog).getByLabelText(
      'Confirm live adjustment for Research Lab',
    );
    expect((postButton as HTMLButtonElement).disabled).toBe(true);
    expect((liveConfirmation as HTMLInputElement).disabled).toBe(true);

    const requestReference = within(dialog).getByLabelText('Request reference');
    const idempotencyKey = (requestReference as HTMLInputElement).value;
    expect(idempotencyKey).toMatch(/^credit-adjustment:/);

    await user.type(within(dialog).getByLabelText('Signed credit amount'), '-2500');
    await user.type(within(dialog).getByLabelText('Reason'), 'Reverse duplicate support grant');
    expect((liveConfirmation as HTMLInputElement).disabled).toBe(false);
    await user.click(liveConfirmation);
    expect((postButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(postButton);

    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect((requestReference as HTMLInputElement).value).toBe(idempotencyKey);

    await user.click(postButton);
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(2));

    const expectedInput = {
      signedCredits: '-2500',
      reason: 'Reverse duplicate support grant',
      idempotencyKey,
    };
    expect(state.create).toHaveBeenNthCalledWith(1, expectedInput);
    expect(state.create).toHaveBeenNthCalledWith(2, expectedInput);
  });
});
