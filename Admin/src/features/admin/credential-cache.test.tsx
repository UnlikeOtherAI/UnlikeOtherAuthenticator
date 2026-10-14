// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCreateApiKeyMutation } from './admin-queries';
import { useCreateBillingAppKeyMutation } from './billing-admin-queries';
import type { BillingAppKeyFormValues } from '../../schemas/billing';
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
afterEach(cleanup);
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
