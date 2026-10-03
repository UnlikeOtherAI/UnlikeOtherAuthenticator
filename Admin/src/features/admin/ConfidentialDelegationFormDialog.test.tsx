// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfidentialDelegationFormDialog } from './ConfidentialDelegationFormDialog';
const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('./admin-queries', () => ({ useDomainsQuery: () => ({ data: [] }) }));
vi.mock('./confidential-delegation-queries', () => ({
  useCreateConfidentialDelegationMutation: () => ({ mutateAsync: mocks.create }),
  useUpdateConfidentialDelegationMutation: () => ({ mutateAsync: mocks.update }),
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mapping = { id: 'mapping', source_domain: 'example.com', product: 'example', resource: 'https://resource.example.com', scopes: ['ai.invoke' as const], enabled: true, created_by_email: 'operator@example.com', updated_by_email: 'operator@example.com', created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z' };
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
