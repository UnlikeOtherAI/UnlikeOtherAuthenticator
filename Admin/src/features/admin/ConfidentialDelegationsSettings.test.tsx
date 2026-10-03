import { MemoryRouter } from 'react-router';
// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfidentialDelegationsSettings } from './ConfidentialDelegationsSettings';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  createMutateAsync: vi.fn(),
  removeMutateAsync: vi.fn(),
  updateMutate: vi.fn(),
  updateMutateAsync: vi.fn(),
}));

const mapping = {
  id: 'mapping-1',
  source_domain: 'api.deepwater.live',
  product: 'deepwater',
  resource: 'https://ledger.unlikeotherai.com',
  scopes: ['ai.invoke'] as const,
  enabled: true,
  created_by_email: 'operator@example.com',
  updated_by_email: 'operator@example.com',
  created_at: '2026-07-19T00:00:00.000Z',
  updated_at: '2026-07-19T00:00:00.000Z',
};

vi.mock('./admin-queries', () => ({
  useDomainsQuery: () => ({
    data: [
      {
        id: 'domain-1',
        name: 'api.deepwater.live',
        status: 'active',
      },
    ],
  }),
}));

vi.mock('./confidential-delegation-queries', () => ({
  useConfidentialDelegationsQuery: () => ({
    data: [mapping],
    isError: false,
    isLoading: false,
  }),
  useCreateConfidentialDelegationMutation: () => ({
    isError: false,
    isPending: false,
    mutateAsync: mocks.createMutateAsync,
  }),
  useUpdateConfidentialDelegationMutation: () => ({
    isError: false,
    isPending: false,
    mutate: mocks.updateMutate,
    mutateAsync: mocks.updateMutateAsync,
  }),
  useDeleteConfidentialDelegationMutation: () => ({
    isError: false,
    isPending: false,
    mutateAsync: mocks.removeMutateAsync,
  }),
}));

vi.mock('../shell/admin-ui', () => ({
  useAdminUi: () => ({ confirm: mocks.confirm }),
}));

describe('ConfidentialDelegationsSettings', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.createMutateAsync.mockResolvedValue(mapping);
    mocks.updateMutateAsync.mockResolvedValue(mapping);
    mocks.removeMutateAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders policy without displaying any application or browser credential', () => {
    render(<MemoryRouter><ConfidentialDelegationsSettings /></MemoryRouter>);

    expect(screen.getByText('deepwater')).toBeTruthy();
    expect(screen.getByText('api.deepwater.live')).toBeTruthy();
    expect(screen.getByText('https://ledger.unlikeotherai.com')).toBeTruthy();
    expect(screen.queryByText(/access-token/i)).toBeNull();
    expect(screen.queryByText(/client secret/i)).toBeNull();
  });

  it('supports explicit disable and guarded delete actions', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ConfidentialDelegationsSettings /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Disable' }));
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      mappingId: 'mapping-1',
      input: { enabled: false },
    });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const confirmation = mocks.confirm.mock.calls[0] as [string, string, () => Promise<void>];
    expect(confirmation[0]).toBe('Delete deepwater delegation?');
    await confirmation[2]();
    expect(mocks.removeMutateAsync).toHaveBeenCalledWith('mapping-1');
  });

  it('keeps source and product immutable while editing mutable policy', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ConfidentialDelegationsSettings /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByText(/permanent bindings/i)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /^Product/ })).toBeNull();
    const resource = screen.getByRole('textbox', { name: /^Resource/ });
    await user.clear(resource);
    await user.type(resource, 'https://ledger.unlikeotherai.com/v2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
        mappingId: 'mapping-1',
        input: {
          resource: 'https://ledger.unlikeotherai.com/v2',
          scopes: ['ai.invoke'],
          enabled: true,
        },
      }),
    );
  });

  it('creates an exact enabled AI-only mapping through the operator form', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ConfidentialDelegationsSettings /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Create mapping' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Source domain' }),
      'api.deepwater.live',
    );
    await user.type(screen.getByRole('textbox', { name: /^Product/ }), 'deepwater');
    await user.type(
      screen.getByRole('textbox', { name: /^Resource/ }),
      'https://ledger.unlikeotherai.com',
    );
    await user.click(
      within(screen.getByRole('dialog', { name: 'Create confidential delegation' })).getByRole(
        'button',
        { name: 'Create mapping' },
      ),
    );

    await waitFor(() =>
      expect(mocks.createMutateAsync).toHaveBeenCalledWith({
        sourceDomain: 'api.deepwater.live',
        product: 'deepwater',
        resource: 'https://ledger.unlikeotherai.com',
        scopes: ['ai.invoke'],
        enabled: true,
      }),
    );
  });

  it('keeps memory read and write separate and unselected until the operator grants them', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ConfidentialDelegationsSettings /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const read = screen.getByRole('checkbox', { name: /Memory read/ }) as HTMLInputElement;
    const write = screen.getByRole('checkbox', { name: /Memory write/ }) as HTMLInputElement;
    expect(read.checked).toBe(false);
    expect(write.checked).toBe(false);
    await user.click(read);
    expect(write.checked).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
        mappingId: 'mapping-1',
        input: { resource: mapping.resource, scopes: ['ai.invoke', 'memory.read'], enabled: true },
      }),
    );
  });

  // `token.provision` is a high-trust scope bounded by the mapping's exact
  // resource. The dialog must say so before an operator saves, and must not claim
  // any authority over UOA's own `/org/*` surface — that surface authenticates the
  // domain pairing and accepts no resource token.
  it('warns that token.provision is high-trust and bounded by the resource', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ConfidentialDelegationsSettings /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // No warning until the high-trust scope is actually selected.
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: /Token provisioning/ }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/high-trust scope/i)).toBeTruthy();
    expect(within(alert).getByText(/the resource is the containment boundary/i)).toBeTruthy();
  });

  it('never claims organisation authority over UOA for an /org-shaped resource', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ConfidentialDelegationsSettings /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const resource = screen.getByRole('textbox', { name: /^Resource/ });
    await user.clear(resource);
    await user.type(resource, 'https://sso.hugopos.eu/org');
    await user.click(screen.getByRole('checkbox', { name: /Token provisioning/ }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByText(/organisation and team authority over UOA/i)).toBeNull();
  });
});

