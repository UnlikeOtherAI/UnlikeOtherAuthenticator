// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeAppIconError, useSaveNativeApp } from './native-app-queries';
import { nativeAppService } from '../../services/native-app-service';
import type { NativeAppForm } from '../../schemas/native-app';
vi.mock('../../services/native-app-service', () => ({
  nativeAppService: { save: vi.fn(), icon: vi.fn(), validateIcon: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('preserves the committed id for icon retry and validates before creation', async () => {
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(useSaveNativeApp, { wrapper });
  const form = {} as NativeAppForm;
  const file = new File(['image'], 'icon.png', { type: 'image/png' });
  vi.mocked(nativeAppService.save).mockResolvedValue({ id: 'created' } as Awaited<
    ReturnType<typeof nativeAppService.save>
  >);
  vi.mocked(nativeAppService.icon).mockRejectedValueOnce(new Error('upload outage'));
  let savedId: string | undefined;
  await act(async () => {
    try {
      await hook.result.current.mutateAsync({ form, file });
    } catch (error) {
      expect(error).toBeInstanceOf(NativeAppIconError);
      savedId = (error as NativeAppIconError).appId;
    }
  });
  expect(savedId).toBe('created');
  await act(async () => {
    await hook.result.current.mutateAsync({ form, file, id: savedId });
  });
  expect(nativeAppService.save).toHaveBeenLastCalledWith(form, 'created');
  vi.mocked(nativeAppService.validateIcon).mockImplementationOnce(() => {
    throw new Error('oversized');
  });
  await act(async () => {
    await expect(hook.result.current.mutateAsync({ form, file })).rejects.toThrow('oversized');
  });
  expect(nativeAppService.save).toHaveBeenCalledTimes(2);
});
