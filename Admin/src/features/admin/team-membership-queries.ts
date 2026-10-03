import { useMutation, useQueryClient } from '@tanstack/react-query';

import { adminService } from '../../services/admin-service';

export function useAddUserToTeamMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: adminService.addUserToTeam,
    onSuccess: async () => {
      // Memberships are embedded in user, organisation, team, domain and dashboard views.
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}
