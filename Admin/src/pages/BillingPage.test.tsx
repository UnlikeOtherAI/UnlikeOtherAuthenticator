// @vitest-environment happy-dom

import { cleanup, render as renderBase, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';

import { ApiRequestError } from '../services/api-client';
import { BillingPage } from './BillingPage';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  createService: vi.fn(),
  createTariff: vi.fn(),
  saveAssignment: vi.fn(),
  createAppKey: vi.fn(),
  setDefault: vi.fn(),
  removeAssignment: vi.fn(),
  revokeAppKey: vi.fn(),
  createAdjustment: vi.fn(),
  deactivateAdjustment: vi.fn(),
  retireTariff: vi.fn(),
  restoreTariff: vi.fn(),
}));

const service = {
  id: 'service-1',
  identifier: 'deepwater',
  name: 'DeepWater',
  active: true,
  tariffs: [
    {
      id: 'tariff-1',
      service_id: 'service-1',
      key: 'standard',
      version: 2,
      name: 'Standard',
      mode: 'standard' as const,
      collection_mode: 'stripe' as const,
      markup_bps: 2000,
      markup_percent: '20.00',
      usage_payment_mode: 'pay_as_you_go',
      monthly_subscription: {
        amount_minor: '2000', currency: 'GBP', charge_basis: 'flat',
        seat_policy: null, seat_charge_timing: null,
      },
      is_default: true,
      retired_at: null,
      retire_blocked_by: ['default', 'assignments', 'subscriptions'],
      created_by_email: 'operator@example.com',
      created_at: '2026-07-20T00:00:00.000Z',
    },
    {
      id: 'tariff-2',
      service_id: 'service-1',
      key: 'team',
      version: 1,
      name: 'Team',
      mode: 'free' as const,
      collection_mode: 'none' as const,
      markup_bps: 0,
      markup_percent: '0.00',
      usage_payment_mode: 'prepaid',
      monthly_subscription: {
        amount_minor: '0', currency: 'GBP', charge_basis: 'flat',
        seat_policy: null, seat_charge_timing: null,
      },
      is_default: false,
      retired_at: null,
      retire_blocked_by: [],
      created_by_email: 'system:migration',
      created_at: '2026-07-20T00:00:00.000Z',
    },
    {
      id: 'tariff-3',
      service_id: 'service-1',
      key: 'legacy',
      version: 4,
      name: 'Legacy',
      mode: 'standard' as const,
      collection_mode: 'manual' as const,
      markup_bps: 1000,
      markup_percent: '10.00',
      usage_payment_mode: 'pay_as_you_go',
      monthly_subscription: {
        amount_minor: '500', currency: 'GBP', charge_basis: 'flat',
        seat_policy: null, seat_charge_timing: null,
      },
      is_default: false,
      retired_at: '2026-09-01T00:00:00.000Z',
      retire_blocked_by: [],
      created_by_email: 'operator@example.com',
      created_at: '2026-01-20T00:00:00.000Z',
    },
  ],
  assignments: [
    {
      id: 'assignment-1',
      tariff_id: 'tariff-1',
      scope: 'team' as const,
      organisation: { id: 'org-1', name: 'Example Org' },
      team: { id: 'team-1', name: 'Research' },
      effective_from_month: '2026-07',
      tariff: {
        id: 'tariff-1',
        service_id: 'service-1',
        key: 'standard',
        version: 2,
        name: 'Standard',
        mode: 'standard' as const,
        collection_mode: 'stripe' as const,
        markup_bps: 2000,
        markup_percent: '20.00',
        usage_payment_mode: 'pay_as_you_go',
        monthly_subscription: {
          amount_minor: '2000', currency: 'GBP', charge_basis: 'flat',
          seat_policy: null, seat_charge_timing: null,
        },
        is_default: true,
        created_by_email: 'operator@example.com',
        created_at: '2026-07-20T00:00:00.000Z',
      },
      created_by_email: 'operator@example.com',
      created_at: '2026-07-20T00:00:00.000Z',
      updated_at: '2026-07-20T00:00:00.000Z',
    },
  ],
  app_keys: [
    {
      id: 'app-key-1',
      purpose: 'customer_lifecycle' as const,
      name: 'DeepWater production',
      key_prefix: 'uoa_app_abcd…',
      actor_issuer: 'https://api.deepwater.example',
      actor_audience: 'https://authentication.example/billing/v1/effective-tariff',
      actor_key_id: 'deepwater-billing-2026',
      checkout_return_origins: ['https://app.nessie.works'],
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      created_by_email: 'operator@example.com',
      created_at: '2026-07-20T00:00:00.000Z',
    },
  ],
  adjustments: [
    {
      id: 'adjustment-1',
      service_id: 'service-1',
      key: 'priority-support',
      name: 'Priority support',
      kind: 'add_on' as const,
      cadence: 'monthly' as const,
      amount_minor: '1000',
      currency: 'GBP',
      scope: 'team' as const,
      scope_key: 'org-1:team-1',
      organisation: { id: 'org-1', name: 'Example Org' },
      team: { id: 'team-1', name: 'Research' },
      starts_at: '2026-07-01T00:00:00.000Z',
      ends_at: null,
      active: true,
      created_by_email: 'operator@example.com',
      created_at: '2026-07-20T00:00:00.000Z',
      updated_at: '2026-07-20T00:00:00.000Z',
    },
  ],
  stripe_catalogs: [],
  stripe_subscriptions: [
    {
      id: 'subscription-1',
      account_id: 'stripe-account-row',
      stripe_account_id: 'acct_test',
      checkout_id: 'checkout-1',
      tariff_id: 'tariff-1',
      tariff_source: 'team' as const,
      tariff_assignment_id: 'assignment-1',
      scope: 'team' as const,
      scope_key: 'org-1:team-1',
      organisation: { id: 'org-1', name: 'Example Org' },
      team: { id: 'team-1', name: 'Research' },
      stripe_subscription_id: 'sub_test',
      stripe_monthly_item_id: 'si_monthly',
      stripe_usage_item_id: 'si_usage',
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: '2026-07-01T00:00:00.000Z',
      current_period_end: '2026-08-01T00:00:00.000Z',
      livemode: false,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-20T00:00:00.000Z',
    },
  ],
  created_at: '2026-07-20T00:00:00.000Z',
  updated_at: '2026-07-20T00:00:00.000Z',
};

vi.mock('../features/admin/billing-admin-queries', () => ({
  useBillingServicesQuery: () => ({ data: [service], isError: false, isLoading: false }),
  useCreateBillingServiceMutation: () => mutation(mocks.createService),
  useCreateBillingTariffMutation: () => mutation(mocks.createTariff),
  useSaveBillingAssignmentMutation: () => mutation(mocks.saveAssignment),
  useCreateBillingAppKeyMutation: () => mutation(mocks.createAppKey),
  useSetDefaultBillingTariffMutation: () => mutation(mocks.setDefault),
  useRemoveBillingAssignmentMutation: () => mutation(mocks.removeAssignment),
  useRevokeBillingAppKeyMutation: () => mutation(mocks.revokeAppKey),
  useCreateBillingAdjustmentMutation: () => mutation(mocks.createAdjustment),
  useDeactivateBillingAdjustmentMutation: () => mutation(mocks.deactivateAdjustment),
  useRetireBillingTariffMutation: () => mutation(mocks.retireTariff),
  useRestoreBillingTariffMutation: () => mutation(mocks.restoreTariff),
}));

vi.mock('../features/admin/billing-ledger-runtime-key-queries', () => ({
  useBillingLedgerRuntimeKeysQuery: () => ({ data: [], isError: false, isLoading: false }),
  useRevokeBillingLedgerRuntimeKeyMutation: () => mutation(vi.fn()),
}));

vi.mock('../features/admin/admin-queries', () => ({
  useOrganisationsQuery: () => ({ data: [] }),
  useTeamsQuery: () => ({ data: [] }),
}));

vi.mock('../features/admin/BillingSeatCapacityPanel', () => ({
  BillingSeatCapacityPanel: () => null,
}));

vi.mock('../features/shell/admin-ui', () => ({
  useAdminUi: () => ({ confirm: mocks.confirm }),
}));

function mutation(mutateAsync: ReturnType<typeof vi.fn>) {
  return {
    error: null,
    isError: false,
    isPending: false,
    mutate: mutateAsync,
    mutateAsync,
  };
}

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(-1)}>Browser back</button>
    </>
  );
}
function render(ui: ReactElement, entry = '/billing?product=service-1') {
  return renderBase(
    <MemoryRouter initialEntries={[entry]}>
      {ui}
      <Location />
    </MemoryRouter>,
  );
}

describe('BillingPage', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  afterEach(cleanup);

  it('shows immutable tariff value, scoped controls, product keys, and test-mode subscriptions', async () => {
    const user = userEvent.setup();
    render(<BillingPage />);

    expect(screen.getByRole('heading', { name: 'Billing' })).toBeTruthy();
    expect(screen.getByText('20.00 GBP per month · usage +20%, pay as you go · card (Stripe)'))
      .toBeTruthy();
    expect(screen.getAllByText('Default')).toHaveLength(1);
    expect(screen.getByRole('link', { name: '1 assignment' }).getAttribute('href'))
      .toBe('/billing?product=service-1&tab=assignments');
    // Created is the date alone; who created it is in the detail dialog.
    expect(screen.queryByText('System')).toBeNull();

    await user.click(screen.getByRole('button', { name: /App keys/ }));
    expect(screen.getByText('DeepWater production')).toBeTruthy();
    expect(screen.getByText('Customer lifecycle')).toBeTruthy();
    expect(screen.getByText('uoa_app_abcd…')).toBeTruthy();
    expect(screen.queryByText(/^uoa_app_[A-Za-z0-9_-]{20,}$/)).toBeNull();

    await user.click(screen.getByRole('button', { name: /Subscriptions/ }));
    expect(screen.getByText('Example Org')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Research' })).toBeTruthy();
    expect(screen.getByText('Test')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add-ons & credits/ }));
    expect(screen.getByText('Priority support')).toBeTruthy();
    expect(screen.getByText('+10.00 GBP')).toBeTruthy();
  });

  it('opens a product from its list, persists its tab, and restores the list with browser Back', async () => {
    const user = userEvent.setup();
    render(<BillingPage />, '/billing');
    const link = screen.getByRole('link', { name: 'DeepWater' });
    expect(link.getAttribute('href')).toBe('/billing?product=service-1');
    await user.click(link);
    expect(screen.getByText(/^20\.00 GBP per month/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Assignments/ }));
    expect(screen.getByTestId('location').textContent).toContain('tab=assignments');
    expect(screen.getByRole('link', { name: 'Research' }).getAttribute('href')).toBe(
      '/organisations/org-1/teams/team-1',
    );
    expect(screen.queryByRole('button', { name: 'New tariff' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Assign tariff' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(screen.getByText(/^20\.00 GBP per month/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(screen.getByRole('link', { name: 'DeepWater' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /App keys/ })).toBeNull();
  });

  it('restores an app key detail directly without exposing plaintext', () => {
    render(<BillingPage />, '/billing?product=service-1&tab=app-keys&record=app-key-1');
    expect(screen.getByRole('dialog', { name: 'DeepWater production' })).toBeTruthy();
    expect(screen.getByText('Actor audience')).toBeTruthy();
    expect(screen.queryByText(/^uoa_app_[A-Za-z0-9_-]{20,}$/)).toBeNull();
  });

  it('opens standard prepaid service terms with no automatic collection by default', async () => {
    const user = userEvent.setup();
    render(<BillingPage />, '/billing');

    await user.click(screen.getByRole('button', { name: 'Add product' }));
    const dialog = screen.getByRole('dialog', { name: 'Add product' });
    expect(dialog).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Mode' }) as HTMLSelectElement).value).toBe(
      'standard',
    );
    expect((screen.getByRole('combobox', { name: /Collection/ }) as HTMLSelectElement).value).toBe(
      'none',
    );
    expect((screen.getByRole('combobox', { name: /^Usage payment/ }) as HTMLSelectElement).value)
      .toBe('prepaid');
    const basisSelect = screen.getByRole('combobox', {
      name: /^Monthly subscription basis/,
    }) as HTMLSelectElement;
    expect(basisSelect.value).toBe('flat');
    expect((screen.getByRole('textbox', { name: /^Monthly price/ }) as HTMLInputElement).value)
      .toBe('0.00');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'Unsaved product');
    await user.click(screen.getByRole('button', { name: 'Close modal' }));
    expect(screen.getByRole('alert').textContent).toContain('Discard unsaved changes?');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement).value).toBe(
      'Unsaved product',
    );
    await user.click(screen.getByRole('button', { name: 'Close modal' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog', { name: 'Add product' })).toBeNull();
  });

  it('retires a version nobody is on after confirmation, hides it, and restores it on request', async () => {
    const user = userEvent.setup();
    render(<BillingPage />);
    expect(screen.queryByText('Legacy')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Retire' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Retire' }));
    expect(mocks.confirm).toHaveBeenCalledWith(
      'Retire Team · team v1?',
      'Nobody can be put on this tariff any more. Its invoices, usage and history stay as they are. You can restore it later.',
      expect.any(Function),
    );
    expect(mocks.retireTariff).not.toHaveBeenCalled();
    await mocks.confirm.mock.calls[0]?.[2]?.();
    expect(mocks.retireTariff).toHaveBeenCalledWith('tariff-2');

    await user.click(screen.getByRole('checkbox', { name: 'Show retired (1)' }));
    expect(screen.getByTestId('location').textContent).toContain('retired=1');
    expect(screen.getByText('Legacy')).toBeTruthy();
    expect(screen.getByText(/^Retired 1 Sept? 2026$/)).toBeTruthy();
    expect(screen.getByRole('row', { name: /Legacy/ }).textContent).toContain('Nobody');
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(mocks.restoreTariff).toHaveBeenCalledWith('tariff-3');
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });

  it('confirms Set default as a routine change and says why a refused change was refused', async () => {
    const user = userEvent.setup();
    mocks.setDefault.mockRejectedValueOnce(new ApiRequestError(409, 'STRIPE_TARIFF_PINNED'));
    render(<BillingPage />);
    await user.click(screen.getByRole('button', { name: 'Set default' }));
    expect(mocks.confirm.mock.calls[0]?.[0]).toBe('Make Team v1 the default?');
    expect(mocks.confirm.mock.calls[0]?.[5]).toBe('primary');
    await mocks.confirm.mock.calls[0]?.[2]?.();
    expect(mocks.setDefault).toHaveBeenCalledWith('tariff-2');
    expect((await screen.findByRole('alert')).textContent)
      .toBe('An active Stripe subscription keeps the current tariff until it ends.');
  });

  it('never offers a retired version for assignment and clears record and paging on tab change', async () => {
    const user = userEvent.setup();
    render(<BillingPage />, '/billing?product=service-1&tab=tariffs&retired=1&tariffs_page=2&record=tariff-1');
    await user.click(screen.getByRole('button', { name: 'Close modal' }));
    await user.click(screen.getByRole('button', { name: /Assignments/ }));
    expect(screen.getByTestId('location').textContent)
      .toBe('/billing?product=service-1&tab=assignments');
    await user.click(screen.getByRole('button', { name: 'Assign tariff' }));
    const tariffs = screen.getByRole('combobox', { name: 'Tariff version' });
    const labels = [...tariffs.querySelectorAll('option')].map((option) => option.textContent);
    // Names are unique among the active tariffs, so each option is the name alone.
    expect(labels).toEqual(['Select tariff', 'Standard · default', 'Team']);
  });
});
