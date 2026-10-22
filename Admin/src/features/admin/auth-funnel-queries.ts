import { useQuery } from '@tanstack/react-query';
import { authFunnelService, type AuthFunnelFilters } from '../../services/auth-funnel-service';

export function useAuthFunnelQuery(filters: AuthFunnelFilters) {
  return useQuery({ queryKey: ['admin', 'auth-funnel', filters], queryFn: () => authFunnelService.get(filters) });
}
