// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import { ConfirmDialog } from '../../components/dialogs/ConfirmDialog';
import type { BillingAssignment, BillingService, BillingTariff } from '../../schemas/billing';
import { ApiRequestError } from '../../services/api-client';
import { AdminUiProvider } from '../shell/admin-ui';
import { BillingOrganisationView } from './BillingOrganisationView';

const mutations = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn() }));

vi.mock('./billing-admin-queries', () => ({
  useSaveBillingAssignmentMutation: () => ({ mutateAsync: mutations.save }),
  useRemoveBillingAssignmentMutation: () => ({ mutateAsync: mutations.remove }),
}));
vi.mock('./OrganisationBillingModePanel', () => ({ OrganisationBillingModePanel: () => null }));

function tariff(id: string, name: string, extra: Partial<BillingTariff> = {}): BillingTariff {
  return {
    id, service_id: 'nessie', key: id, version: 1, name, mode: 'standard', collection_mode: 'stripe',
    markup_bps: 3000, markup_percent: '30', usage_payment_mode: 'prepaid', usage_currency: 'USD',
    monthly_subscription: { amount_minor: '399', currency: 'USD', charge_basis: 'per_seat',
      seat_policy: 'automatic', seat_charge_timing: 'full_month' },
    is_default: false, retired_at: null, retire_blocked_by: [], created_by_email: null,
    created_at: '2026-10-01T00:00:00.000Z', ...extra,
  };
}

const standard = tariff('standard', 'Standard', { is_default: true });
const free = tariff('free', 'Free', { mode: 'free', markup_bps: 0, collection_mode: 'none',
  monthly_subscription: { amount_minor: '0', currency: 'USD', charge_basis: 'flat', seat_policy: null,
    seat_charge_timing: null } });
const retired = tariff('legacy', 'Legacy', { retired_at: '2026-11-01T00:00:00.000Z' });
const hugoAssignment: BillingAssignment = {
  id: 'a-hugo', tariff_id: 'free', scope: 'team', organisation: { id: 'o1', name: 'Acme' },
  team: { id: 't1', name: 'Hugo' }, tariff: free, effective_from_month: '2026-10',
  created_by_email: 'ops@example.test', created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
};
const nessie: BillingService = {
  id: 'nessie', identifier: 'nessie', name: 'Nessie', active: true, tariffs: [standard, free, retired],
  assignments: [hugoAssignment], app_keys: [], adjustments: [], stripe_catalogs: [], stripe_subscriptions: [],
  created_at: '', updated_at: '',
};
const teams = [
  { id: 't1', orgId: 'o1', name: 'Hugo', members: 4 },
  { id: 't2', orgId: 'o1', name: 'Zeta', members: 1 },
];

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/billing?section=organisations&organisation=o1']}>
      <AdminUiProvider>
        <BillingOrganisationView organisation={{ id: 'o1', name: 'Acme', slug: 'acme' }} products={[nessie]}
          teams={teams} />
        <ConfirmDialog />
      </AdminUiProvider>
    </MemoryRouter>,
  );
}

const select = (name: string) => screen.getByRole<HTMLSelectElement>('combobox', { name });

beforeEach(() => {
  mutations.save.mockReset();
  mutations.remove.mockReset();
});
afterEach(cleanup);

describe('BillingOrganisationView', () => {
  it('offers active tariffs only, with the fallback named through the organisation', () => {
    renderView();
    expect([...select('Tariff for Zeta').options].map((option) => option.text)).toEqual([
      'Same as organisation — Standard', 'Free', 'Standard',
    ]);
    expect(select('Tariff for the entire organisation').options[0]?.text).toBe('Product default — Standard');
    expect(screen.getByRole('button', { name: /Nessie/ }).textContent).toContain('1');
  });

  it('edits one row at a time, keeps a refused selection and saves on retry', async () => {
    const user = userEvent.setup();
    renderView();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await user.selectOptions(select('Tariff for Zeta'), 'standard');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(select('Tariff for Hugo').disabled).toBe(true);
    expect(select('Tariff for the entire organisation').disabled).toBe(true);

    mutations.save.mockRejectedValueOnce(new ApiRequestError(409, 'STRIPE_TARIFF_PINNED'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('dialog', { name: 'Move Zeta to Standard?' });
    expect(dialog.textContent).toContain('This month keeps its current terms.');
    // A routine move is confirmed with the primary button, never the destructive one.
    const move = within(dialog).getByRole('button', { name: 'Move Zeta to Standard' });
    expect(move.className).toContain('bg-indigo');
    await user.click(move);
    const refusal = 'An active Stripe subscription keeps the current tariff until it ends.';
    expect(await screen.findByText(refusal)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(refusal);
    expect(select('Tariff for Zeta').value).toBe('standard');

    mutations.save.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Move Zeta to Standard' }));
    await waitFor(() => expect(mutations.save).toHaveBeenLastCalledWith({
      organisationId: 'o1', teamId: 't2', tariffId: 'standard',
    }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(select('Tariff for Hugo').disabled).toBe(false);
  });

  it('cancels back to what is saved', async () => {
    const user = userEvent.setup();
    renderView();
    await user.selectOptions(select('Tariff for Hugo'), 'standard');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(select('Tariff for Hugo').value).toBe('free');
    expect(select('Tariff for Zeta').disabled).toBe(false);
    expect(mutations.save).not.toHaveBeenCalled();
  });

  it('removes a team tariff when the first option is chosen', async () => {
    const user = userEvent.setup();
    mutations.remove.mockResolvedValueOnce(undefined);
    renderView();
    await user.selectOptions(select('Tariff for Hugo'), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('dialog', { name: "Remove Hugo's own tariff?" });
    expect(dialog.textContent).toContain('(UTC) Hugo uses Standard.');
    const removeButton = within(dialog).getByRole('button', { name: "Remove Hugo's own tariff" });
    expect(removeButton.className).toContain('bg-red');
    await user.click(removeButton);
    await waitFor(() => expect(mutations.remove).toHaveBeenCalledWith('a-hugo'));
    expect(mutations.save).not.toHaveBeenCalled();
  });
});
