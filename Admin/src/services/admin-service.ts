import type { AdminData, Domain, SearchResult, Team, UserSummary } from '../features/admin/types';
import { createApiClient } from './api-client';

const api = createApiClient();

export type DomainSecretResponse = {
  client_hash: string;
  client_hash_prefix: string;
  client_secret: string;
  domain: Domain;
};

export const adminService = {
  getDashboard: () => api.get<AdminData>('/internal/admin/dashboard'),
  getDomains: () => api.get<AdminData['domains']>('/internal/admin/domains'),
  createDomain: (input: { clientSecret: string; domain: string; label: string }) =>
    api.post<DomainSecretResponse>('/internal/admin/domains', {
      client_secret: input.clientSecret,
      domain: input.domain,
      label: input.label,
    }),
  updateDomain: (domain: string, input: { label?: string; status?: 'active' | 'disabled' }) =>
    api.put<Domain>(`/internal/admin/domains/${encodeURIComponent(domain)}`, input),
  rotateDomainSecret: (domain: string) =>
    api.post<DomainSecretResponse>(`/internal/admin/domains/${encodeURIComponent(domain)}/rotate-secret`),
  getOrganisations: () => api.get<AdminData['organisations']>('/internal/admin/organisations'),
  getOrganisation: (orgId: string) =>
    api.get<AdminData['organisations'][number] | null>(`/internal/admin/organisations/${encodeURIComponent(orgId)}`),
  getTeams: () => api.get<Array<Team & { orgName: string }>>('/internal/admin/teams'),
  getTeam: (orgId: string, teamId: string) =>
    api.get<{ org: AdminData['organisations'][number]; team: Team | null } | null>(
      `/internal/admin/organisations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}`,
    ),
  getUsers: () => api.get<UserSummary[]>('/internal/admin/users'),
  getUser: (userId: string) => api.get<UserSummary | null>(`/internal/admin/users/${encodeURIComponent(userId)}`),
  getLogs: () => api.get<AdminData['logs']>('/internal/admin/logs'),
  getHandshakeErrors: () => api.get<AdminData['handshakeErrors']>('/internal/admin/handshake-errors'),
  getSettings: () => api.get<Pick<AdminData, 'bans' | 'apps'>>('/internal/admin/settings'),
  search: (query: string) => api.get<SearchResult[]>(`/internal/admin/search?q=${encodeURIComponent(query)}`),
};

export type AdminServiceData = AdminData;
export type TeamWithOrg = Team & { orgName: string };
export type UserLookup = UserSummary | null;
