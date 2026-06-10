import { listHandshakeErrorLogs } from './handshake-error-log.service.js';
import { emptyBans, emptyData, getAdminStats } from './internal-admin.service.base.js';
import { getAdminApps } from './internal-admin.service.apps.js';
import { getAdminDomains } from './internal-admin.service.domains.js';
import { getAdminOrganisations } from './internal-admin.service.organisations.js';
import { getAdminLogs, getAdminUsers } from './internal-admin.service.users.js';

export {
  createAdminApp,
  createAdminFeatureFlag,
  createAdminKillSwitch,
  deleteAdminFeatureFlag,
  deleteAdminKillSwitch,
  getAdminApps,
  updateAdminFeatureFlag,
  updateAdminKillSwitch,
} from './internal-admin.service.apps.js';
export { getAdminDomain, getAdminDomains } from './internal-admin.service.domains.js';
export {
  createAdminOrganisation,
  getAdminOrganisation,
  getAdminOrganisations,
  getAdminTeam,
  getAdminTeams,
  updateAdminOrganisation,
  updateAdminTeam,
} from './internal-admin.service.organisations.js';
export {
  getAdminLogs,
  getAdminUser,
  getAdminUsers,
  resetAdminUserTwoFactor,
} from './internal-admin.service.users.js';

export async function getAdminSession(claims: { userId: string; email: string; domain: string }) {
  return {
    ok: true,
    adminUser: {
      id: claims.userId,
      email: claims.email,
      domain: claims.domain,
      role: 'superuser',
    },
  };
}

export async function getAdminDashboard() {
  const [stats, domains, organisations, users, logs, handshakeErrors] = await Promise.all([
    getAdminStats(),
    getAdminDomains(),
    getAdminOrganisations(),
    getAdminUsers(),
    getAdminLogs(100),
    listHandshakeErrorLogs({ limit: 100 }),
  ]);

  return {
    ...emptyData(),
    stats,
    domains,
    organisations,
    users,
    logs,
    handshakeErrors,
  };
}

export async function getAdminSettings() {
  return { bans: emptyBans, apps: await getAdminApps() };
}

export async function searchAdmin(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const [organisations, users] = await Promise.all([getAdminOrganisations(), getAdminUsers()]);
  const orgMatches = organisations
    .filter((org) => org.name.toLowerCase().includes(normalized) || org.slug.toLowerCase().includes(normalized))
    .slice(0, 4)
    .map((organisation) => ({ type: 'organisation', organisation }));
  const teamMatches = organisations
    .flatMap((organisation) => organisation.teams.map((team) => ({ type: 'team', organisation, team })))
    .filter(({ team }) => team.name.toLowerCase().includes(normalized))
    .slice(0, 4);
  const userMatches = users
    .filter((user) => (user.name ?? '').toLowerCase().includes(normalized) || user.email.toLowerCase().includes(normalized))
    .slice(0, 5)
    .map((user) => ({ type: 'user', user }));

  return [...orgMatches, ...teamMatches, ...userMatches];
}
