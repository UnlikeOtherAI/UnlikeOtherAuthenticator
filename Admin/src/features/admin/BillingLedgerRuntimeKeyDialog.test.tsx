// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { BillingService } from '../../schemas/billing';
import { BillingLedgerRuntimeKeyDialog } from './BillingLedgerRuntimeKeyDialog';
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../services/billing-ledger-runtime-key-service', () => ({
  billingLedgerRuntimeKeyService: { create: mocks.create },
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const secret = `uoa_ledger_${'a'.repeat(43)}`;
const result = { id: 'runtime-1', key_prefix: 'uoa_ledger_fixture',
  created_at: '2026-10-07T12:00:00.000Z', secret };
const service = { id: 'nessie-1', identifier: 'nessie', name: 'Nessie', active: true } as BillingService;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const close = vi.fn();
  const view = render(<QueryClientProvider client={client}>
    <BillingLedgerRuntimeKeyDialog service={service} onClose={close} />
  </QueryClientProvider>);
  return { client, close, ...view };
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /^Source domain/ }), 'api.nessie.works');
  await user.type(screen.getByRole('textbox', { name: /^Ledger audience/ }),
    'https://ledger.unlikeotherai.com');
}
it('retains failed inputs, blocks double submits/dismissal while pending, and guards dirty close', async () => {
  let finish!: (value: typeof result) => void;
  mocks.create.mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const user = userEvent.setup(); const { close, client } = mount();
  await fill(user);
  await user.keyboard('{Escape}');
  expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  await user.click(screen.getByRole('button', { name: 'Issue runtime key' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Check the key list');
  expect((screen.getByRole('textbox', { name: /^Source domain/ }) as HTMLInputElement).value)
    .toBe('api.nessie.works');
  await user.click(screen.getByRole('button', { name: 'Issue runtime key' }));
  await user.keyboard('{Enter}{Escape}');
  expect(mocks.create).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled();
  await act(async () => finish(result));
  expect(screen.getByRole('dialog', { name: 'Ledger runtime key issued' })).toBeTruthy();
  expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(secret);
  expect(client.getMutationCache().getAll()).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'I have stored this key' }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByText(secret)).toBeNull();
});
it('never stores the secret or resurrects a pending reveal after navigation/logout unmount', async () => {
  let finish!: (value: typeof result) => void;
  mocks.create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const storage = [vi.spyOn(Storage.prototype, 'setItem')];
  const user = userEvent.setup(); const { unmount, client } = mount();
  await fill(user); await user.click(screen.getByRole('button', { name: 'Issue runtime key' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  unmount(); await act(async () => finish(result));
  expect(screen.queryByText(secret)).toBeNull();
  expect(client.getMutationCache().getAll()).toHaveLength(0);
  for (const spy of storage) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
});
it('reopening starts blank after the one-time dialog unmounts', async () => {
  mocks.create.mockResolvedValue(result);
  const user = userEvent.setup(); const { unmount } = mount();
  await fill(user); await user.click(screen.getByRole('button', { name: 'Issue runtime key' }));
  expect(await screen.findByText(secret)).toBeTruthy();
  unmount(); mount();
  expect(screen.queryByText(secret)).toBeNull();
  expect((screen.getByRole('textbox', { name: /^Source domain/ }) as HTMLInputElement).value).toBe('');
});
