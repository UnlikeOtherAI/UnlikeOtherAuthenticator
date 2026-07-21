// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditBillingInvoiceBuyerDialog } from './BillingInvoiceProfileDialogs';

const state = vi.hoisted(() => ({
  buyer: {
    data: null as null | undefined,
    error: null as Error | null,
    fetchStatus: 'idle',
    isError: false,
    isPending: false,
  },
  refetch: vi.fn(),
  resetSave: vi.fn(),
  save: vi.fn(),
}));

vi.mock('./billing-contract-queries', () => ({
  useBillingInvoiceBuyerQuery: () => ({ ...state.buyer, refetch: state.refetch }),
  useSaveBillingInvoiceBuyerMutation: () => ({
    error: null,
    isPending: false,
    mutateAsync: state.save,
    reset: state.resetSave,
  }),
}));

async function completeRequiredBuyerFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: 'Legal name' }), 'Acme Research Ltd');
  await user.type(screen.getByRole('textbox', { name: 'Billing email' }), 'accounts@acme.example');
  await user.type(screen.getByRole('textbox', { name: 'Address line 1' }), '2 Customer Road');
  await user.type(screen.getByRole('textbox', { name: 'City' }), 'Bristol');
  await user.type(screen.getByRole('textbox', { name: 'Postal code' }), 'BS1 1AA');
  await user.type(screen.getByRole('textbox', { name: /^Country code/ }), 'gb');
}

describe('EditBillingInvoiceBuyerDialog', () => {
  beforeEach(() => {
    state.buyer.data = null;
    state.buyer.error = null;
    state.buyer.fetchStatus = 'idle';
    state.buyer.isError = false;
    state.buyer.isPending = false;
    state.refetch.mockReset().mockResolvedValue(undefined);
    state.resetSave.mockReset();
    state.save.mockReset().mockResolvedValue({ organisation_id: 'org-1' });
  });

  afterEach(cleanup);

  it('allows creation only when UOA explicitly returns a missing buyer profile', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<EditBillingInvoiceBuyerDialog organisationId="org-1" onClose={onClose} />);

    expect(screen.getByText(/No buyer profile exists yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry loading' })).toBeNull();
    await completeRequiredBuyerFields(user);
    await user.click(screen.getByRole('button', { name: 'Save buyer profile' }));

    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith({
        organisationId: 'org-1',
        legalName: 'Acme Research Ltd',
        billingEmail: 'accounts@acme.example',
        line1: '2 Customer Road',
        line2: '',
        city: 'Bristol',
        region: '',
        postalCode: 'BS1 1AA',
        country: 'GB',
        taxIdentifier: '',
        purchaseOrderReference: '',
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a network/server lookup error and offers an explicit retry', async () => {
    state.buyer.data = undefined;
    state.buyer.error = new Error('Upstream unavailable');
    state.buyer.isError = true;
    const user = userEvent.setup();
    render(<EditBillingInvoiceBuyerDialog organisationId="org-1" onClose={vi.fn()} />);

    expect(screen.getByText(/could not be verified/i)).toBeTruthy();
    expect(screen.getByText(/Saving is disabled to prevent an accidental overwrite/i)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save buyer profile' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await completeRequiredBuyerFields(user);
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(state.save).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});
