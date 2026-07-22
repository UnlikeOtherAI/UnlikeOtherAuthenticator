// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingCreditAccount } from '../../schemas/billing-credits';
import { BillingCreditAccountsPanel } from './BillingCreditAccountsPanel';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  preview: vi.fn(),
  resetCreate: vi.fn(),
  resetPreview: vi.fn(),
  fetchNext: vi.fn(),
  search: vi.fn(),
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
  useBillingCreditAccountsQuery: (search: string) => {
    state.search(search);
    return {
      data: { pages: [{ accounts: [account], next_cursor: 'next-page', has_more: true }] },
      isError: false,
      isLoading: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: state.fetchNext,
    };
  },
  useCreateBillingCreditAdjustmentMutation: () => ({
    error: null,
    isError: false,
    isPending: false,
    mutateAsync: state.create,
    reset: state.resetCreate,
  }),
  usePreviewBillingCreditAdjustmentMutation: () => ({
    error: null,
    isError: false,
    isPending: false,
    mutateAsync: state.preview,
    reset: state.resetPreview,
  }),
}));

describe('BillingCreditAccountsPanel', () => {
  beforeEach(() => {
    state.create.mockReset().mockResolvedValue({
      account,
      adjustment: account.recent_adjustments[0],
      replayed: false,
    });
    state.preview.mockReset().mockResolvedValue({
      account,
      current_credits: account.remaining_credits,
      signed_credits: {
        credits: '-2500',
        display: '-2,500 credits',
        usd_equivalent: { amount: '-2.5', currency: 'USD', display: '-US$2.50' },
      },
      resulting_credits: {
        credits: '40375',
        display: '40,375 credits',
        usd_equivalent: { amount: '40.375', currency: 'USD', display: 'US$40.38' },
      },
      reason: 'Reverse duplicate support grant',
      idempotency_key: 'server-key',
      automatic_top_up: {
        generation: 3,
        state: 'active',
        threshold_credits: {
          credits: '10000',
          display: '10,000 credits',
          usd_equivalent: { amount: '10', currency: 'USD', display: 'US$10.00' },
        },
        refill_credits: {
          credits: '50000',
          display: '50,000 credits',
          usd_equivalent: { amount: '50', currency: 'USD', display: 'US$50.00' },
        },
        consequence: {
          code: 'remains_above_threshold',
          message: 'The resulting balance remains above the threshold.',
        },
      },
      expires_at: '2026-07-21T11:02:00.000Z',
      confirmation_token: 'server-confirmation-token',
    });
    state.resetCreate.mockReset();
    state.resetPreview.mockReset();
    state.fetchNext.mockReset().mockResolvedValue(undefined);
    state.search.mockClear();
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
    expect(screen.getByText('1 loaded')).toBeTruthy();
    expect(screen.getAllByText('credit-account-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('org-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('team-1').length).toBeGreaterThan(0);
  });

  it('searches and can enumerate further exact accounts', async () => {
    const user = userEvent.setup();
    render(<BillingCreditAccountsPanel />);
    await user.type(screen.getByLabelText('Search team credit accounts'), 'Research Lab');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(state.search).toHaveBeenLastCalledWith('Research Lab');
    await user.click(screen.getByRole('button', { name: 'Load more accounts' }));
    expect(state.fetchNext).toHaveBeenCalledTimes(1);
  });

  it('posts only an exact server confirmation token and retains it for retry', async () => {
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
    expect(within(dialog).getByText('credit-account-1')).toBeTruthy();

    const requestReference = within(dialog).getByLabelText('Request reference');
    const idempotencyKey = (requestReference as HTMLInputElement).value;
    expect(idempotencyKey).toMatch(/^credit-adjustment:/);

    await user.type(within(dialog).getByLabelText('Signed credit amount'), '-2500');
    await user.type(within(dialog).getByLabelText('Reason'), 'Reverse duplicate support grant');
    const reviewButton = within(dialog).getByRole('button', { name: 'Review adjustment' });
    await user.click(reviewButton);
    await waitFor(() => expect(state.preview).toHaveBeenCalledTimes(1));

    expect(within(dialog).getByText('Server-confirmed adjustment')).toBeTruthy();
    expect(within(dialog).getByText('40,375 credits')).toBeTruthy();
    expect(within(dialog).getByText('Live customer balance')).toBeTruthy();
    expect(within(dialog).getByText(/Refill:/).textContent).toContain('50,000 credits');
    const postButton = within(dialog).getByRole('button', { name: 'Post reviewed adjustment' });
    const liveConfirmation = within(dialog).getByLabelText(
      'Confirm live adjustment for Research Lab',
    );
    expect((postButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(liveConfirmation);
    expect((postButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(postButton);

    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect((requestReference as HTMLInputElement).value).toBe(idempotencyKey);

    await user.click(postButton);
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(2));

    expect(state.preview).toHaveBeenCalledWith({
      signedCredits: '-2500',
      reason: 'Reverse duplicate support grant',
      idempotencyKey,
    });
    expect(state.create).toHaveBeenNthCalledWith(1, 'server-confirmation-token');
    expect(state.create).toHaveBeenNthCalledWith(2, 'server-confirmation-token');
  });

  it('guards form submission and invalidates live acknowledgement after edit and revert', async () => {
    const user = userEvent.setup();
    render(<BillingCreditAccountsPanel />);

    await user.click(screen.getByRole('button', { name: 'Adjust' }));
    const dialog = screen.getByRole('dialog', { name: 'Adjust team credits' });
    const signedCredits = within(dialog).getByLabelText('Signed credit amount');
    const reason = within(dialog).getByLabelText('Reason');
    await user.type(signedCredits, '-2500');
    await user.type(reason, 'Reverse duplicate support grant');
    await user.click(within(dialog).getByRole('button', { name: 'Review adjustment' }));
    await waitFor(() => expect(state.preview).toHaveBeenCalledTimes(1));

    const form = dialog.querySelector('form');
    if (!form) throw new Error('Adjustment form was not rendered');
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(state.create).not.toHaveBeenCalled();

    await user.click(within(dialog).getByLabelText('Confirm live adjustment for Research Lab'));
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Post reviewed adjustment',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    await user.type(reason, '!');
    await user.keyboard('{Backspace}');

    expect(within(dialog).queryByText('Server-confirmed adjustment')).toBeNull();
    expect(within(dialog).queryByLabelText('Confirm live adjustment for Research Lab')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Review adjustment' })).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });
});
