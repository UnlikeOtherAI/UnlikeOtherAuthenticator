import { Link, useNavigate, useParams } from 'react-router-dom';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useLogsQuery, useOrganisationsQuery, useUserQuery } from '../features/admin/admin-queries';
import type { Organisation, OrganisationMember, Team } from '../features/admin/types';
import { useAdminUi } from '../features/shell/admin-ui';

type TeamMembership = {
  organisation: Organisation;
  member: OrganisationMember;
  team: Team;
};

export function UserDetailPage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { confirm, openDialog } = useAdminUi();
  const userQuery = useUserQuery(userId ?? null);
  const orgsQuery = useOrganisationsQuery();
  const logsQuery = useLogsQuery();
  const user = userQuery.data;
  const organisations = orgsQuery.data ?? [];
  const memberships = buildMemberships(organisations, userId);
  const recentLogs = logsQuery.data?.filter((log) => log.user === user?.email) ?? [];
  const { pageItems, pagination } = usePagination(memberships);

  if (userQuery.isLoading || orgsQuery.isLoading) {
    return <p className="text-sm text-gray-400">Loading user...</p>;
  }

  if (!user) {
    return <p className="text-sm text-gray-400">User not found.</p>;
  }

  return (
    <>
      <PageHeader
        title={user.name ?? user.email}
        description={`${user.email} · Registered ${user.created}`}
        leading={<Avatar label={user.name ?? user.email} size="md" />}
        badges={
          <>
            <StatusBadge status={user.status} />
            <StatusBadge status={user.twofa ? 'On' : 'Off'} />
            <MethodBadge method={user.method} />
          </>
        }
        onBack={() => navigate('/users')}
        actions={
          <>
            <Button onClick={() => openDialog({ type: 'edit-user', user })}>Edit User</Button>
            <Button variant="primary" onClick={() => openDialog({ type: 'add-user-to-team', user, organisations })}>Add to Team</Button>
            <Button onClick={() => confirm(`Reset 2FA for ${user.email}?`, 'They will need to re-enroll before completing a protected login.')}>Reset 2FA</Button>
            <Button variant={user.status === 'banned' ? 'secondary' : 'danger'} onClick={() => confirm(`${user.status === 'banned' ? 'Unban' : 'Ban'} ${user.email}?`, 'This is mocked until the admin API is available.')}>
              {user.status === 'banned' ? 'Unban' : 'Ban User'}
            </Button>
          </>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Domains" value={user.domains.length > 0 ? user.domains.join(', ') : 'Linked by org'} />
        <Metric label="Organisations" value={String(new Set(memberships.map((membership) => membership.organisation.id)).size)} />
        <Metric label="Teams" value={String(memberships.length)} />
        <Metric label="Last Login" value={user.lastLogin} />
      </div>
      <Card>
        <CardHeader>
          <span className="text-sm font-semibold text-gray-900">Teams</span>
          <Button icon="plus" size="sm" variant="primary" onClick={() => openDialog({ type: 'add-user-to-team', user, organisations })}>Add to Team</Button>
        </CardHeader>
        <DataTable headers={['Organisation', 'Team', 'Org Role', 'Team Role', 'Members', 'Actions']}>
          {pageItems.map(({ member, organisation, team }) => (
            <tr
              key={`${organisation.id}-${team.id}`}
              className="cursor-pointer transition-colors hover:bg-gray-50"
              tabIndex={0}
              onClick={() => navigate(`/organisations/${organisation.id}/teams/${team.id}`)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  navigate(`/organisations/${organisation.id}/teams/${team.id}`);
                }
              }}
            >
              <Td><Link className="font-medium text-indigo-600 hover:text-indigo-900" to={`/organisations/${organisation.id}`} onClick={(event) => event.stopPropagation()}>{organisation.name}</Link></Td>
              <Td>
                <Link className="font-medium text-indigo-600 hover:text-indigo-900" to={`/organisations/${organisation.id}/teams/${team.id}`} onClick={(event) => event.stopPropagation()}>{team.name}</Link>
                {team.isDefault ? <Badge className="ml-2" variant="blue">Default</Badge> : null}
              </Td>
              <Td><StatusBadge status={member.role} /></Td>
              <Td><StatusBadge status={member.teamRoles[team.name] ?? 'member'} /></Td>
              <Td>{team.members}</Td>
              <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                <ActionButton tone="amber" onClick={() => openDialog({ type: 'change-team-role', organisation, team, member })}>Change Role</ActionButton>
                <ActionDivider />
                <ActionButton tone="red" onClick={() => confirm(`Remove from ${team.name}?`, `${user.email} will stay in the user directory.`)}>Remove</ActionButton>
              </Td>
            </tr>
          ))}
        </DataTable>
        <PaginationFooter {...pagination} />
      </Card>
      <Card className="mt-4">
        <CardHeader>
          <span className="text-sm font-semibold text-gray-900">Recent Login Activity</span>
        </CardHeader>
        <div className="divide-y divide-gray-100">
          {recentLogs.slice(0, 5).map((log) => (
            <div key={log.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <span className="text-gray-700">{log.ts}</span>
              <span className="text-xs text-gray-400">{log.domain} · {log.userAgent}</span>
              <Badge variant={log.result === 'ok' ? 'green' : 'red'}>{log.result.toUpperCase()}</Badge>
            </div>
          ))}
          {recentLogs.length === 0 ? <p className="px-5 py-4 text-sm text-gray-400">No recent logins.</p> : null}
        </div>
      </Card>
    </>
  );
}

function buildMemberships(organisations: Organisation[], userId: string | undefined): TeamMembership[] {
  if (!userId) {
    return [];
  }

  return organisations.flatMap((organisation) => {
    const member = organisation.members.find((item) => item.id === userId);

    if (!member) {
      return [];
    }

    return member.teams.flatMap((teamName) => {
      const team = organisation.teams.find((item) => item.name === teamName);
      return team ? [{ organisation, member, team }] : [];
    });
  });
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-gray-900">{value}</p>
    </Card>
  );
}
