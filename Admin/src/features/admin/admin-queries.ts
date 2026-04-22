import { useQuery } from '@tanstack/react-query';

import { adminService } from '../../services/admin-service';
import type { IntegrationRequestStatus } from './types';

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
