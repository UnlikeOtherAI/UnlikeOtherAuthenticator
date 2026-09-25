import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nativeAppService } from '../../services/native-app-service';
import type { NativeAppForm } from '../../schemas/native-app';
const queryKey = ['admin', 'native-apps'];
export function useNativeApps() { return useQuery({ queryKey, queryFn: nativeAppService.list }); }
export function useSaveNativeApp() {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ form, id, file }: { form: NativeAppForm; id?: string; file?: File | null }) => {
    const app = await nativeAppService.save(form, id);
    if (file !== undefined) await nativeAppService.icon(app.id, file);
    return app;
  }, onSuccess: () => client.invalidateQueries({ queryKey }) });
}
