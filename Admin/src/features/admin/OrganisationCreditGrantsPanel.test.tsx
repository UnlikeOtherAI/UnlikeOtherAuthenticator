// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingOrganisationCreditGrants } from '../../schemas/billing-credit-grants';
import { ApiRequestError } from '../../services/api-client';
import { OrganisationCreditGrantsPanel } from './OrganisationCreditGrantsPanel';

const service = vi.hoisted(() => ({ read: vi.fn(), grant: vi.fn() }));
vi.mock('../../services/billing-credit-grant-service', () => ({ billingCreditGrantService: service }));
vi.mock('../auth/admin-oauth', () => ({ beginAdminSystemSignIn: vi.fn() }));

const amount = (credits: bigint) => ({ microcredits: (credits * 1_000_000n).toString(),
  credits: credits.toString(), usd: (Number(credits) / 1000).toString() });

function wallet(balance: bigint, grants: BillingOrganisationCreditGrants['grants'] = []): BillingOrganisationCreditGrants {
  return { organisation: { id: 'o1', name: 'Acme' }, mode: 'live', credit_account_id: balance ? 'w1' : null,
    balance: { confirmed: amount(balance), reserved: amount(0n), spendable: amount(balance) },
    limits: { max_credits: '10000000', reason_min: 12, reason_max: 500 }, grants, has_more: false };
}

const grant = { id: 'g1', credit_entry_id: 'e1', amount: amount(10_000n), reason: 'Launch allowance for Acme',
  granted_by: 'ops@example.test', granted_at: '2026-11-17T10:00:00.000Z', mode: 'live' as const };

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}><OrganisationCreditGrantsPanel organisationId="o1" /></QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => { service.read.mockReset(); service.grant.mockReset(); });
afterEach(cleanup);

describe('OrganisationCreditGrantsPanel', () => {
  it('grants credits with a reason, keeps the key across a refused attempt and shows the new balance', async () => {
    const user = userEvent.setup();
    service.read.mockResolvedValueOnce(wallet(0n)).mockResolvedValue(wallet(10_000n, [grant]));
    service.grant.mockRejectedValueOnce(new ApiRequestError(401, 'BILLING_CREDIT_GRANT_FRESH_SESSION_REQUIRED'))
      .mockResolvedValueOnce({ grant, replayed: false, balance_after: amount(10_000n) });
    renderPanel();
    expect(await screen.findByText('No credits have been granted to this organisation.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Grant credits' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant credits · Acme' });
    const submit = within(dialog).getByRole('button', { name: 'Grant credits' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Credits to grant/), '10000');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Launch allowance for Acme');
    expect(dialog.textContent).toContain('Acme gets 10,000 credits (US$10.00) now, in live billing.');
    expect(dialog.textContent).toContain('Balance goes from 0 credits to 10,000 credits.');

    await user.click(submit);
    expect((await within(dialog).findByRole('alert')).textContent).toContain('last five minutes');
    expect(within(dialog).getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    await user.click(submit);

    const done = await screen.findByRole('dialog', { name: 'Credits granted · Acme' });
    expect(done.textContent).toContain('New balance: 10,000 credits (US$10.00).');
    // The retry reuses the first attempt's key, so a lost response cannot grant twice.
    const [first, second] = service.grant.mock.calls;
    expect(second).toEqual(first);
    expect(second?.[0]).toBe('o1');
    expect(second?.[1]).toEqual({ credits: '10000', reason: 'Launch allowance for Acme',
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await user.click(within(done).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Launch allowance for Acme')).toBeTruthy();
  });

  it('refuses fractional and over-limit amounts before sending anything', async () => {
    const user = userEvent.setup();
    service.read.mockResolvedValue(wallet(0n));
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Grant credits' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant credits · Acme' });
    await user.type(within(dialog).getByLabelText(/Reason/), 'Launch allowance for Acme');
    for (const value of ['1.5', '0', '10000001']) {
      const input = within(dialog).getByLabelText(/Credits to grant/);
      await user.clear(input);
      await user.type(input, value);
      expect(dialog.textContent).toContain('Enter a whole number of credits within the limit.');
      expect((within(dialog).getByRole('button', { name: 'Grant credits' }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(service.grant).not.toHaveBeenCalled();
  });
});
