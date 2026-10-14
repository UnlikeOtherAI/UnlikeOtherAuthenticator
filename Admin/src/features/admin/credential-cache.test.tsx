// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode, type PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCreateApiKeyMutation } from './admin-queries';
import { useCreateBillingAppKeyMutation } from './billing-admin-queries';
import type { BillingAppKeyFormValues } from '../../schemas/billing';
import { adminService } from '../../services/admin-service';
import { billingAdminService } from '../../services/billing-admin-service';
import { clearStoredAdminSession } from '../auth/admin-session-storage';
vi.mock('../../services/admin-service', () => ({
  adminService: {
    createApiKey: vi.fn(async () => ({ id: 'synthetic-id', key: 'one-time-synthetic-secret' })),
  },
}));
vi.mock('../../services/billing-admin-service', () => ({
  billingAdminService: {
    createAppKey: vi.fn(async () => ({ id: 'billing-key', secret: 'one-time-billing-secret' })),
  },
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each(['automation', 'product'] as const)(
  '%s key delivery cannot call its reveal owner after unmount, signout or closing/reopening', async (kind) => {
    for (const destination of ['unmount', 'signout', 'reopen'] as const) {
      const client = new QueryClient();
      const reveal = vi.fn();
      let finish!: () => void;
      if (kind === 'automation') {
        vi.mocked(adminService.createApiKey).mockImplementationOnce(() => new Promise((resolve) => {
          finish = () => resolve({ id: 'late-id', key: 'late-secret' } as Awaited<ReturnType<typeof adminService.createApiKey>>);
        }));
      } else {
        vi.mocked(billingAdminService.createAppKey).mockImplementationOnce(() => new Promise((resolve) => {
          finish = () => resolve({ key: 'late-secret' } as Awaited<ReturnType<typeof billingAdminService.createAppKey>>);
        }));
      }
      const wrapper = ({ children }: PropsWithChildren) => (
        <StrictMode><QueryClientProvider client={client}>{children}</QueryClientProvider></StrictMode>
      );
      const hook = renderHook(({ open }) => {
        const automation = useCreateApiKeyMutation(reveal, open);
        const product = useCreateBillingAppKeyMutation('service', reveal, open);
        return kind === 'automation' ? automation : product;
      }, { wrapper, initialProps: { open: true } });
      let pending!: Promise<void>;
      act(() => { pending = hook.result.current.mutateAsync({ name: 'CI' } as BillingAppKeyFormValues); });
      await act(async () => { await Promise.resolve(); });
      if (destination === 'unmount') hook.unmount();
      if (destination === 'signout') act(() => clearStoredAdminSession());
      if (destination === 'reopen') { hook.rerender({ open: false }); hook.rerender({ open: true }); }
      await act(async () => { finish(); await pending; });
      expect(reveal).not.toHaveBeenCalled();
      expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state))).not.toContain('late-secret');
      expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain('late-secret');
      hook.unmount();
    }
  },
);
it('delivers a one-time key without retaining plaintext in mutation/query caches', async () => {
  const client = new QueryClient();
  const reveal = vi.fn();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useCreateApiKeyMutation(reveal), { wrapper });
  await act(async () => {
    await hook.result.current.mutateAsync({ name: 'CI' });
  });
  expect(reveal).toHaveBeenCalledWith({ id: 'synthetic-id', key: 'one-time-synthetic-secret' });
  expect(client.getMutationCache().getAll()[0]?.state.data).toBeUndefined();
  expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(
    'one-time-synthetic-secret',
  );
});

it('delivers a product key without retaining the plaintext mutation result', async () => {
  const client = new QueryClient();
  const reveal = vi.fn();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useCreateBillingAppKeyMutation('service', reveal), { wrapper });
  await act(async () => {
    await hook.result.current.mutateAsync({ name: 'Product' } as BillingAppKeyFormValues);
  });
  expect(reveal).toHaveBeenCalledWith({ id: 'billing-key', secret: 'one-time-billing-secret' });
  expect(client.getMutationCache().getAll()[0]?.state.data).toBeUndefined();
});
