// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BillingCreditAccount } from '../../schemas/billing-credits';
import { billingAdminService } from '../../services/billing-admin-service';
import {
  billingCreditAccountsKey,
  useBillingCreditAccountsQuery,
  useCreateBillingCreditAdjustmentMutation,
  usePreviewBillingCreditAdjustmentMutation,
} from './billing-admin-queries';

const account = {
  id: 'credit-account-1',
  organisation: { id: 'org-1', name: 'Example Org' },
  team: { id: 'team-1', name: 'Research' },
  mode: 'test' as const,
  remaining_credits: {
    credits: '1000',
    display: '1,000 credits',
    usd_equivalent: { amount: '1', currency: 'USD' as const, display: 'US$1.00' },
  },
  updated_at: '2026-07-21T10:00:00.000Z',
  recent_adjustments: [],
} satisfies BillingCreditAccount;

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('billing credit account queries', () => {
  it('loads the UOA-owned account projection', async () => {
    vi.spyOn(billingAdminService, 'listCreditAccounts').mockResolvedValue({
      accounts: [account],
      next_cursor: null,
      has_more: false,
    });
    const { wrapper } = harness();

    const { result } = renderHook(() => useBillingCreditAccountsQuery(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0].accounts).toEqual([account]);
    expect(billingAdminService.listCreditAccounts).toHaveBeenCalledTimes(1);
  });

  it('requests a server confirmation preview with the exact form values', async () => {
    const input = {
      signedCredits: '1000',
      reason: 'Verified support grant',
      idempotencyKey: 'support:team-1:2026-07-21',
    };
    const preview = vi.spyOn(billingAdminService, 'previewCreditAdjustment').mockResolvedValue({
      account,
      current_credits: account.remaining_credits,
      signed_credits: account.remaining_credits,
      resulting_credits: account.remaining_credits,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
      automatic_top_up: {
        generation: 0,
        state: 'disabled',
        threshold_credits: null,
        refill_credits: null,
        consequence: { code: 'not_active', message: 'Automatic top-up is not active.' },
      },
      expires_at: '2026-07-21T10:02:00.000Z',
      confirmation_token: 'confirmation-token',
    });
    const { wrapper } = harness();
    const { result } = renderHook(() => usePreviewBillingCreditAdjustmentMutation(account), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync(input);
    });
    expect(preview).toHaveBeenCalledWith(account, input);
  });

  it('refreshes shared balances after an adjustment succeeds', async () => {
    const response = {
      account,
      adjustment: {
        id: 'adjustment-1',
        signed_credits: {
          credits: '1000',
          display: '+1,000 credits',
          usd_equivalent: { amount: '1', currency: 'USD' as const, display: '+US$1.00' },
        },
        reason: 'Verified support grant',
        idempotency_key: 'support:team-1:2026-07-21',
        created_by: {
          user_id: 'operator-1',
          email: 'operator@example.com',
          admin_domain: 'admin.example.com',
        },
        created_at: '2026-07-21T10:00:00.000Z',
      },
      replayed: false,
    };
    const create = vi
      .spyOn(billingAdminService, 'createCreditAdjustment')
      .mockResolvedValue(response);
    const { queryClient, wrapper } = harness();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateBillingCreditAdjustmentMutation(account.id), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync('confirmation-token');
    });

    expect(create).toHaveBeenCalledWith(account.id, 'confirmation-token');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingCreditAccountsKey });
  });
});
