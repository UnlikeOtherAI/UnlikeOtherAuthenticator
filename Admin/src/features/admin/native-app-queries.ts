import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeAppService } from '../../services/native-app-service';
import type { NativeAppForm } from '../../schemas/native-app';
export class NativeAppIconError extends Error {
  constructor(public readonly appId: string) {
    super('App saved. The icon could not be saved. Choose an image and retry.');
  }
}
const queryKey = ['admin', 'native-apps'];
export function useNativeApps() {
  return useQuery({ queryKey, queryFn: nativeAppService.list });
}
export function useSaveNativeApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      form,
      id,
      file,
    }: {
      form: NativeAppForm;
      id?: string;
      file?: File | null;
    }) => {
      nativeAppService.validateIcon(file);
      const app = await nativeAppService.save(form, id);
      if (file !== undefined) {
        try {
          await nativeAppService.icon(app.id, file);
        } catch {
          await client.invalidateQueries({ queryKey });
          throw new NativeAppIconError(app.id);
        }
      }
      return app;
    },
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
}
