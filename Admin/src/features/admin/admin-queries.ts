import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { adminService } from '../../services/admin-service';
import type { AppPlatformKind, IntegrationRequestStatus } from './types';
import type { KillSwitchInput } from '../../services/admin-service';

export function useDashboardQuery() {
  return useQuery({ queryKey: ['admin', 'dashboard'], queryFn: adminService.getDashboard });
}

export function useDomainsQuery() {
  return useQuery({ queryKey: ['admin', 'domains'], queryFn: adminService.getDomains });
}

export function useDomainQuery(domain: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'domain', domain],
    queryFn: () => adminService.getDomain(domain ?? ''),
    enabled: Boolean(domain),
  });
}

export function useOrganisationsQuery() {
  return useQuery({ queryKey: ['admin', 'organisations'], queryFn: adminService.getOrganisations });
}

export function useCreateOrganisationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: adminService.createOrganisation,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'organisations'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'domains'] });
    },
  });
}

export function useOrganisationQuery(orgId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'organisation', orgId],
    queryFn: () => adminService.getOrganisation(orgId ?? ''),
    enabled: Boolean(orgId),
  });
}

export function useTeamsQuery() {
  return useQuery({ queryKey: ['admin', 'teams'], queryFn: adminService.getTeams });
}

export function useTeamQuery(orgId: string | undefined, teamId: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'team', orgId, teamId],
    queryFn: () => adminService.getTeam(orgId ?? '', teamId ?? ''),
    enabled: Boolean(orgId && teamId),
  });
}

export function useUsersQuery() {
  return useQuery({ queryKey: ['admin', 'users'], queryFn: adminService.getUsers });
}

export function useUserQuery(userId: string | null) {
  return useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => adminService.getUser(userId ?? ''),
    enabled: Boolean(userId),
  });
}

export function useLogsQuery() {
  return useQuery({ queryKey: ['admin', 'logs'], queryFn: adminService.getLogs });
}

export function useHandshakeErrorsQuery() {
  return useQuery({ queryKey: ['admin', 'handshake-errors'], queryFn: adminService.getHandshakeErrors });
}

export function useSettingsQuery() {
  return useQuery({ queryKey: ['admin', 'settings'], queryFn: adminService.getSettings });
}

export function useCreateBanMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: adminService.createBan,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
  });
}

export function useDeleteBanMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => adminService.deleteBan(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
  });
}

export function useCreateAppMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; identifier: string; platform: AppPlatformKind; domain: string; orgId: string }) =>
      adminService.createApp(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
  });
}

function invalidateFeatureFlagQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
}

export function useCreateFeatureFlagMutation(appId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { key: string; description?: string; defaultState: boolean }) =>
      adminService.createFeatureFlag(appId, input),
    onSuccess: () => invalidateFeatureFlagQueries(queryClient),
  });
}

export function useUpdateFeatureFlagMutation(appId: string, flagId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { key: string; description?: string; defaultState: boolean }) =>
      adminService.updateFeatureFlag(appId, flagId, input),
    onSuccess: () => invalidateFeatureFlagQueries(queryClient),
  });
}

export function useDeleteFeatureFlagMutation(appId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (flagId: string) => adminService.deleteFeatureFlag(appId, flagId),
    onSuccess: () => invalidateFeatureFlagQueries(queryClient),
  });
}

export function useCreateKillSwitchMutation(appId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: KillSwitchInput) => adminService.createKillSwitch(appId, input),
    onSuccess: () => invalidateFeatureFlagQueries(queryClient),
  });
}

export function useUpdateKillSwitchMutation(appId: string, killSwitchId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: KillSwitchInput) => adminService.updateKillSwitch(appId, killSwitchId, input),
    onSuccess: () => invalidateFeatureFlagQueries(queryClient),
  });
}

export function useDeleteKillSwitchMutation(appId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (killSwitchId: string) => adminService.deleteKillSwitch(appId, killSwitchId),
    onSuccess: () => invalidateFeatureFlagQueries(queryClient),
  });
}

export function useIntegrationRequestsQuery(status?: IntegrationRequestStatus) {
  return useQuery({
    queryKey: ['admin', 'integration-requests', status ?? 'all'],
    queryFn: () => adminService.getIntegrationRequests(status),
  });
}

export function useIntegrationRequestQuery(id: string | null | undefined) {
  return useQuery({
    queryKey: ['admin', 'integration-request', id],
    queryFn: () => adminService.getIntegrationRequest(id ?? ''),
    enabled: Boolean(id),
  });
}

export function useDomainJwksQuery(domain: string | null | undefined) {
  return useQuery({
    queryKey: ['admin', 'domain-jwks', domain],
    queryFn: () => adminService.getDomainJwks(domain ?? ''),
    enabled: Boolean(domain),
  });
}

export function useDomainEmailQuery(domain: string | null | undefined) {
  return useQuery({
    queryKey: ['admin', 'domain-email', domain],
    queryFn: () => adminService.getDomainEmail(domain ?? ''),
    enabled: Boolean(domain),
  });
}

export function useSuperusersQuery() {
  return useQuery({ queryKey: ['admin', 'superusers'], queryFn: adminService.getSuperusers });
}

export function useSuperuserSearchQuery(query: string) {
  return useQuery({
    queryKey: ['admin', 'superusers', 'search', query],
    queryFn: () => adminService.searchSuperusers(query),
    enabled: query.trim().length > 1,
  });
}
