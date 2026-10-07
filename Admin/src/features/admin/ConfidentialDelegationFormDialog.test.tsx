// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfidentialDelegationFormDialog } from './ConfidentialDelegationFormDialog';
const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('./admin-queries', () => ({
  useDomainsQuery: () => ({
    data: [{ id: 'coder-domain', name: 'coder.unlikeotherai.com', status: 'active' }],
  }),
}));
vi.mock('./confidential-delegation-queries', () => ({
  useCreateConfidentialDelegationMutation: () => ({ mutateAsync: mocks.create }),
  useUpdateConfidentialDelegationMutation: () => ({ mutateAsync: mocks.update }),
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mapping = { id: 'mapping', source_domain: 'example.com', product: 'example', resource: 'https://resource.example.com', scopes: ['ai.invoke' as const], enabled: true, created_by_email: 'operator@example.com', updated_by_email: 'operator@example.com', created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z' };

it('creates the exact Coder to Selkie binding with only the operator-selected broker scope', async () => {
  const close = vi.fn();
  const user = userEvent.setup();
  render(<ConfidentialDelegationFormDialog open mapping={null} onClose={close} />);

  const broker = screen.getByRole('checkbox', { name: /Session brokering/ });
  expect((broker as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('checkbox', { name: /AI invocation/ }) as HTMLInputElement).checked)
    .toBe(true);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Source domain' }),
    'coder.unlikeotherai.com');
  await user.type(screen.getByRole('textbox', { name: /Product/ }), 'coder');
  await user.type(screen.getByRole('textbox', { name: /Resource/ }), 'https://api.selkie.live');
  await user.click(screen.getByRole('checkbox', { name: /AI invocation/ }));
  await user.click(broker);
  await user.click(screen.getByRole('button', { name: 'Create mapping' }));

  await waitFor(() => expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
    sourceDomain: 'coder.unlikeotherai.com',
    product: 'coder',
    resource: 'https://api.selkie.live',
    scopes: ['session:broker'],
    enabled: true,
  }));
  expect(mocks.update).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it('renders an existing broker-only mapping and preserves its scope when editing', async () => {
  const close = vi.fn();
  const user = userEvent.setup();
  render(<ConfidentialDelegationFormDialog open onClose={close} mapping={{
    ...mapping,
    source_domain: 'coder.unlikeotherai.com',
    product: 'coder',
    resource: 'https://api.selkie.live',
    scopes: ['session:broker'],
  }} />);

  expect((screen.getByRole('checkbox', { name: /Session brokering/ }) as HTMLInputElement).checked)
    .toBe(true);
  for (const label of ['AI invocation', 'Billing read', 'Memory read', 'Memory write',
    'Token provisioning']) {
    expect((screen.getByRole('checkbox', { name: new RegExp(label) }) as HTMLInputElement).checked)
      .toBe(false);
  }
  await user.click(screen.getByRole('checkbox', { name: /Mapping enabled/ }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    mappingId: 'mapping',
    input: { resource: 'https://api.selkie.live', scopes: ['session:broker'], enabled: false },
  }));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it('guards a dirty scope edit and retains exact update scope/resource after failure', async () => {
  let finish!: () => void;
  mocks.update.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const close = vi.fn(); const user = userEvent.setup();
  render(<ConfidentialDelegationFormDialog open mapping={mapping} onClose={close} />);
  await user.click(screen.getByRole('checkbox', { name: /Memory read/ }));
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText(/The mapping could not be saved/)).toBeTruthy();
  expect(mocks.update).toHaveBeenCalledWith({ mappingId: 'mapping', input: { resource: 'https://resource.example.com', scopes: ['ai.invoke', 'memory.read'], enabled: true } });
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(close).toHaveBeenCalledOnce();
});
