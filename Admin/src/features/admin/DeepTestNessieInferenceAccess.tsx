import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Card } from '../../components/ui/Card';
import { adminService } from '../../services/admin-service';
import type { UserSummary } from './types';

export function DeepTestNessieInferenceAccess({ user }: { user: UserSummary }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (allowed: boolean) => adminService.setDeepTestNessieInferenceAccess(user.id, allowed),
    onSuccess: async (result) => {
      queryClient.setQueryData<UserSummary>(['admin', 'user', user.id],
        (current) => current ? { ...current, deeptestNessieInferenceAllowed: result.allowed } : current);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'user', user.id] });
    },
  });
  return (
    <Card className="mb-5 p-5">
      <h2 className="text-sm font-semibold text-gray-900">DeepTest inference</h2>
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm text-gray-900">
        <input type="checkbox" checked={user.deeptestNessieInferenceAllowed === true}
          disabled={mutation.isPending || user.status !== 'active'}
          onChange={(event) => mutation.mutate(event.target.checked)} />
        Allow Nessie executor inference
      </label>
      <p className="mt-1 text-sm text-gray-600">Allow this person to use a paired Nessie computer for DeepTest inference.</p>
      {mutation.isPending ? <p role="status" className="mt-2 text-sm text-gray-600">Saving permission…</p> : null}
      {mutation.isError ? <p role="alert" className="mt-2 text-sm text-red-700">The permission could not be saved. Try again.</p> : null}
    </Card>
  );
}
