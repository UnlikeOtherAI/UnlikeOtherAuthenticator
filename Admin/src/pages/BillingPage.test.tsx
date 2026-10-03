// @vitest-environment happy-dom

import { cleanup, render as renderBase, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';

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
      monthly_subscription: { amount_minor: '2000', currency: 'GBP' },
      is_default: true,
      created_by_email: 'operator@example.com',
      created_at: '2026-07-20T00:00:00.000Z',
    },
  ],
  assignments: [
    {
      id: 'assignment-1',
      tariff_id: 'tariff-1',
      scope: 'team' as const,
      organisation: { id: 'org-1', name: 'Example Org' },
      team: { id: 'team-1', name: 'Research' },
      tariff: {
        id: 'tariff-1',
        service_id: 'service-1',
        key: 'standard',
        version: 2,
        name: 'Standard',
        mode: 'standard' as const,
        collection_mode: 'stripe' as const,
        markup_bps: 2000,
        monthly_subscription: { amount_minor: '2000', currency: 'GBP' },
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
}));

vi.mock('../features/admin/admin-queries', () => ({
  useOrganisationsQuery: () => ({ data: [] }),
  useTeamsQuery: () => ({ data: [] }),
}));

vi.mock('../features/shell/admin-ui', () => ({
  useAdminUi: () => ({ confirm: mocks.confirm }),
}));

function mutation(mutateAsync: ReturnType<typeof vi.fn>) {
  return {
    error: null,
    isError: false,
    isPending: false,
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
    expect(screen.getByText('20.00%')).toBeTruthy();
    expect(screen.getByText('20.00 GBP')).toBeTruthy();
    expect(screen.getAllByText('Default')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /App keys/ }));
    expect(screen.getByText('DeepWater production')).toBeTruthy();
    expect(screen.getByText('customer lifecycle')).toBeTruthy();
    expect(screen.getByText('uoa_app_abcd…')).toBeTruthy();
    expect(screen.queryByText(/^uoa_app_[A-Za-z0-9_-]{20,}$/)).toBeNull();

    await user.click(screen.getByRole('button', { name: /Stripe subscriptions/ }));
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
    expect(screen.getByText('20.00 GBP')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Assignments/ }));
    expect(screen.getByTestId('location').textContent).toContain('tab=assignments');
    expect(screen.getByRole('link', { name: 'Research' }).getAttribute('href')).toBe(
      '/organisations/org-1/teams/team-1',
    );
    expect(screen.queryByRole('button', { name: 'Tariff version' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(screen.getByText('20.00 GBP')).toBeTruthy();
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

  it('opens a safe at-cost/no-collection service form by default', async () => {
    const user = userEvent.setup();
    render(<BillingPage />);

    await user.click(screen.getByRole('button', { name: 'Add service' }));
    const dialog = screen.getByRole('dialog', { name: 'Add billing service' });
    expect(dialog).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Mode' }) as HTMLSelectElement).value).toBe(
      'at_cost',
    );
    expect((screen.getByRole('combobox', { name: /Collection/ }) as HTMLSelectElement).value).toBe(
      'none',
    );
  });
});
