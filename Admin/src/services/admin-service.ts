import type {
  AdminData,
  Domain,
  DomainDirectoryDetail,
  DomainJwk,
  IntegrationClaimCredentials,
  IntegrationClaimDeliveryMode,
  IntegrationRequestDetail,
  IntegrationRequestDetailWithCredentials,
  IntegrationRequestStatus,
  IntegrationRequestSummary,
  SearchResult,
  Team,
  UserSummary,
} from '../features/admin/types';
import { createApiClient } from './api-client';

const api = createApiClient();

export type DomainSecretResponse = {
  client_hash: string;
  client_hash_prefix: string;
  client_secret: string;
  domain: Domain;
};

export type DomainRotateResponse = {
  domain: string;
  contact_email: string;
  delivery_mode: IntegrationClaimDeliveryMode;
  email_dispatched: boolean;
  hash_prefix: string;
  credentials?: IntegrationClaimCredentials;
};

export const adminService = {
  getDashboard: () => api.get<AdminData>('/internal/admin/dashboard'),
  getDomains: () => api.get<AdminData['domains']>('/internal/admin/domains'),
  getDomain: (domain: string) =>
    api.get<DomainDirectoryDetail | null>(`/internal/admin/domains/${encodeURIComponent(domain)}`),
  createDomain: (input: { clientSecret: string; domain: string; label: string }) =>
    api.post<DomainSecretResponse>('/internal/admin/domains', {
      client_secret: input.clientSecret,
      domain: input.domain,
      label: input.label,
    }),
  updateDomain: (domain: string, input: { label?: string; status?: 'active' | 'disabled' }) =>
    api.put<Domain>(`/internal/admin/domains/${encodeURIComponent(domain)}`, input),
  rotateDomainSecret: (domain: string, deliveryMode: IntegrationClaimDeliveryMode = 'email') =>
    api.post<DomainRotateResponse>(
      `/internal/admin/domains/${encodeURIComponent(domain)}/rotate-secret`,
      { deliveryMode },
    ),
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
  getIntegrationRequests: (status?: IntegrationRequestStatus) => {
    const suffix = status ? `?status=${status}` : '';
    return api.get<IntegrationRequestSummary[]>(`/internal/admin/integration-requests${suffix}`);
  },
  getIntegrationRequest: (id: string) =>
    api.get<IntegrationRequestDetail | null>(`/internal/admin/integration-requests/${encodeURIComponent(id)}`),
  acceptIntegrationRequest: (
    id: string,
    body?: { label?: string; clientSecret?: string; deliveryMode?: 'email' | 'reveal' },
  ) =>
    api.post<IntegrationRequestDetailWithCredentials>(
      `/internal/admin/integration-requests/${encodeURIComponent(id)}/accept`,
      body && Object.keys(body).length > 0
        ? {
            label: body.label,
            clientSecret: body.clientSecret,
            deliveryMode: body.deliveryMode,
          }
        : undefined,
    ),
  declineIntegrationRequest: (id: string, reason: string) =>
    api.post<IntegrationRequestDetail>(
      `/internal/admin/integration-requests/${encodeURIComponent(id)}/decline`,
      { reason },
    ),
  deleteIntegrationRequest: (id: string) =>
    api.delete<{ ok: boolean }>(`/internal/admin/integration-requests/${encodeURIComponent(id)}`),
  resendIntegrationClaim: (id: string, deliveryMode: 'email' | 'reveal' = 'email') =>
    api.post<IntegrationRequestDetailWithCredentials>(
      `/internal/admin/integration-requests/${encodeURIComponent(id)}/resend-claim`,
      { deliveryMode },
    ),
  getDomainJwks: (domain: string) =>
    api.get<DomainJwk[]>(`/internal/admin/domains/${encodeURIComponent(domain)}/jwks`),
  addDomainJwk: (domain: string, jwk: Record<string, unknown>) =>
    api.post<DomainJwk>(`/internal/admin/domains/${encodeURIComponent(domain)}/jwks`, { jwk }),
  deactivateDomainJwk: (domain: string, kid: string) =>
    api.delete<DomainJwk>(
      `/internal/admin/domains/${encodeURIComponent(domain)}/jwks/${encodeURIComponent(kid)}`,
    ),
};

export type AdminServiceData = AdminData;
export type TeamWithOrg = Team & { orgName: string };
export type UserLookup = UserSummary | null;
