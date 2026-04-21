import { mockAdminData } from '../features/admin/mock-data';
import type { AdminData, SearchResult, Team, UserSummary } from '../features/admin/types';

const delay = 80;

export const adminService = {
  getDashboard: () => resolve(mockAdminData),
  getDomains: () => resolve(mockAdminData.domains),
  getOrganisations: () => resolve(mockAdminData.organisations),
  getOrganisation: (orgId: string) => resolve(mockAdminData.organisations.find((org) => org.id === orgId) ?? null),
  getTeams: () => resolve(mockAdminData.organisations.flatMap((org) => org.teams.map((team) => ({ ...team, orgName: org.name })))),
  getTeam: (orgId: string, teamId: string) => {
    const org = mockAdminData.organisations.find((item) => item.id === orgId);
    return resolve(org ? { org, team: org.teams.find((team) => team.id === teamId) ?? null } : null);
  },
  getUsers: () => resolve(mockAdminData.users),
  getUser: (userId: string) => resolve(findUser(userId)),
  getLogs: () => resolve(mockAdminData.logs),
  getSettings: () => resolve({ bans: mockAdminData.bans, apps: mockAdminData.apps }),
  search: (query: string) => resolve(searchAll(query)),
};

function resolve<T>(value: T): Promise<T> {
  return new Promise((done) => {
    window.setTimeout(() => done(value), delay);
  });
}

function findUser(userId: string): UserSummary | null {
  const directUser = mockAdminData.users.find((user) => user.id === userId);

  if (directUser) {
    return directUser;
  }

  const member = mockAdminData.organisations.flatMap((org) => org.members).find((item) => item.id === userId);

  if (!member) {
    return null;
  }

  return {
    id: member.id,
    name: member.name,
    email: member.email,
    domains: [],
    twofa: member.twofa,
    lastLogin: member.lastLogin,
    status: member.status,
    method: member.method,
    created: 'Unknown',
  };
}

function searchAll(query: string): SearchResult[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return [];
  }

  const orgMatches = mockAdminData.organisations
    .filter((org) => includes(org.name, normalized) || includes(org.slug, normalized))
    .slice(0, 4)
    .map<SearchResult>((organisation) => ({ type: 'organisation', organisation }));

  const teamMatches = mockAdminData.organisations
    .flatMap((organisation) =>
      organisation.teams.map((team) => ({
        type: 'team' as const,
        organisation,
        team,
      })),
    )
    .filter(({ team }) => includes(team.name, normalized))
    .slice(0, 4);

  const userMatches = mockAdminData.users
    .filter((user) => includes(user.name ?? '', normalized) || includes(user.email, normalized))
    .slice(0, 5)
    .map<SearchResult>((user) => ({ type: 'user', user }));

  return [...orgMatches, ...teamMatches, ...userMatches];
}

function includes(value: string, query: string) {
  return value.toLowerCase().includes(query);
}

export type AdminServiceData = AdminData;
export type TeamWithOrg = Team & { orgName: string };
export type UserLookup = UserSummary | null;
