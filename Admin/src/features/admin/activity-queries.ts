import { useQuery } from '@tanstack/react-query';
import { createApiClient } from '../../services/api-client';
import type { LoginLog } from './types';

const api = createApiClient();
export function useActivityQuery(userId?: string) {
  return useQuery({
    queryKey: ['admin', 'activity', userId],
    queryFn: () => api.get<LoginLog[]>(`/internal/admin/logs?limit=500${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`),
  });
}
export function useUserLogsQuery(userId: string) {
  return useQuery({
    queryKey: ['admin', 'user-activity', userId],
    enabled: !!userId,
    queryFn: () => api.get<LoginLog[]>(`/internal/admin/logs?limit=100&userId=${encodeURIComponent(userId)}`),
  });
}
