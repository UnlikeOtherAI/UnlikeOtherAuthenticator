// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingService } from '../../schemas/billing';
import type { BillingContract, BillingContractVersion } from '../../schemas/billing-contracts';
import { ActivateBillingContractVersionDialog } from './BillingContractDialogs';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
}));

vi.mock('./billing-contract-queries', () => ({
  useActivateBillingContractVersionMutation: () => ({
    error: null,
    isPending: false,
    mutateAsync: mocks.activate,
  }),
}));

const money = {
  amount_minor: '5000',
  amount: '50',
  currency: 'USD',
  display: '$50.00',
};

const version: BillingContractVersion = {
  id: 'version-2',
  version: 2,
  usage_markup_bps: 4000,
  usage_markup_percent: '40.00',
  currency: 'USD',
  payment_terms_days: 30,
  effective_from_month: '2026-08',
  services: [],
  actions: { activation_state: 'ready', activate: true },
  created_at: '2026-07-21T00:00:00.000Z',
};

const contract: BillingContract = {
  id: 'contract-1',
  organisation_id: 'org-1',
  organisation_name: 'Acme Research',
  reference: 'MSA-2026-001',
  name: 'Enterprise AI services',
  status: 'active',
  activated_at: '2026-07-01T00:00:00.000Z',
  terminated_at: null,
  versions: [
    {
      ...version,
      id: 'version-1',
      version: 1,
      effective_from_month: '2026-07',
      actions: { activation_state: 'active', activate: false },
      services: [
        {
          service_id: 'service-1',
          service_identifier: 'deepwater',
          service_name: 'DeepWater',
          tariff_id: 'tariff-1',
          monthly_amount_minor: '5000',
          monthly_price: money,
        },
      ],
    },
    version,
  ],
  actions: { add_version: true },
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-07-21T00:00:00.000Z',
};

function service(id: string, name: string, identifier: string, active: boolean): BillingService {
  return {
    id,
    identifier,
    name,
    active,
    tariffs: [],
    assignments: [],
    app_keys: [],
    adjustments: [],
    stripe_catalogs: [],
    stripe_subscriptions: [],
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
  };
}

const services = [
  service('service-1', 'DeepWater', 'deepwater', true),
  service('service-2', 'DeepTest', 'deeptest', true),
  service('service-3', 'Retired Signal', 'retired-signal', false),
];

describe('ActivateBillingContractVersionDialog', () => {
  beforeEach(() => {
    mocks.activate.mockReset().mockResolvedValue(version);
  });

  afterEach(cleanup);

  it('lists only active billing services and starts every price explicitly off and blank', () => {
    render(
      <ActivateBillingContractVersionDialog
        contract={contract}
        version={version}
        services={services}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /DeepWater/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /DeepTest/ })).toBeTruthy();
    expect(screen.queryByText('Retired Signal')).toBeNull();

    const deepWaterAmount = screen.getByRole('textbox', {
      name: 'DeepWater monthly amount in minor units',
    }) as HTMLInputElement;
    const deepTestAmount = screen.getByRole('textbox', {
      name: 'DeepTest monthly amount in minor units',
    }) as HTMLInputElement;
    expect(deepWaterAmount.value).toBe('');
    expect(deepWaterAmount.disabled).toBe(true);
    expect(deepTestAmount.value).toBe('');
    expect(deepTestAmount.disabled).toBe(true);
    expect(screen.getByText(/0 services selected/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Activate immutable terms' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('requires an explicit amount and confirmation, then invalidates confirmation on edits', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ActivateBillingContractVersionDialog
        contract={contract}
        version={version}
        services={services}
        onClose={onClose}
      />,
    );

    const serviceToggle = screen.getByRole('checkbox', { name: /DeepWater/ });
    const confirmation = screen.getByRole('checkbox', {
      name: /I confirm these exact monthly prices/,
    }) as HTMLInputElement;
    const amount = screen.getByRole('textbox', {
      name: 'DeepWater monthly amount in minor units',
    }) as HTMLInputElement;
    const activate = screen.getByRole('button', {
      name: 'Activate immutable terms',
    }) as HTMLButtonElement;

    await user.click(serviceToggle);
    expect(amount.disabled).toBe(false);
    expect(activate.disabled).toBe(true);
    await user.type(amount, '5000');
    expect(activate.disabled).toBe(true);
    await user.click(confirmation);
    expect(activate.disabled).toBe(false);

    await user.clear(amount);
    await user.type(amount, '7500');
    expect(confirmation.checked).toBe(false);
    expect(activate.disabled).toBe(true);
    await user.click(confirmation);
    expect(activate.disabled).toBe(false);

    await user.click(screen.getByRole('checkbox', { name: /DeepTest/ }));
    expect(confirmation.checked).toBe(false);
    expect(activate.disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /DeepTest/ }));
    await user.click(confirmation);
    await user.click(activate);

    await waitFor(() =>
      expect(mocks.activate).toHaveBeenCalledWith([
        { serviceId: 'service-1', monthlyAmountMinor: '7500' },
      ]),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
