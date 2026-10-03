import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { useDirectoryParam } from '../features/admin/useDirectoryParam';
import { SegmentedTabs } from '../components/ui/Tabs';
import { useUserLogsQuery } from '../features/admin/activity-queries';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useOrganisationsQuery, useUserQuery } from '../features/admin/admin-queries';
import { UserAvatar } from '../features/admin/UserAvatar';
import { UserAvatarSection } from '../features/admin/UserAvatarSection';
import type { AvatarSource, Organisation, OrganisationMember, Team } from '../features/admin/types';
import { adminService } from '../services/admin-service';
import { useAdminUi } from '../features/shell/admin-ui';

const avatarSourceLabels: Record<AvatarSource, string> = {
  uploaded: 'Uploaded',
  provider: 'From provider',
  generated: 'Generated',
};

type TeamMembership = {
  organisation: Organisation;
  member: OrganisationMember;
  team: Team;
};

export function UserDetailPage() {
  const { userId } = useParams();
  const { recordState, openRecord, goBack } = useDirectoryNavigation('/users');
  const queryClient = useQueryClient();
  const { confirm } = useAdminUi();
  const [rawTab, setTab] = useDirectoryParam('tab', 'memberships');
  const tab = ['profile', 'security', 'activity'].includes(rawTab) ? rawTab : 'memberships';
  const userQuery = useUserQuery(userId ?? null);
  const orgsQuery = useOrganisationsQuery();
  const logsQuery = useUserLogsQuery(userId ?? '');
  const user = userQuery.data;
  const organisations = orgsQuery.data ?? [];
  const memberships = buildMemberships(organisations, userId);
  const recentLogs = logsQuery.data ?? [];
  const { pageItems, pagination } = usePagination(memberships);
  const resetTwoFa = useMutation({
    mutationFn: () => adminService.resetUserTwoFactor(userId ?? ''),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });

  if (userQuery.isError) return <div role="alert">Could not load user. <Button onClick={() => void userQuery.refetch()}>Retry</Button></div>;

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
        leading={<UserAvatar userId={user.id} label={user.name ?? user.email} size="md" />}
        badges={
          <>
            <StatusBadge status={user.status} />
            <Badge variant={user.twofa ? 'green' : 'slate'}>{user.twofa ? '2FA enabled' : '2FA not enrolled'}</Badge>
            <MethodBadge method={user.method} />
            {user.avatarSource ? <Badge variant="slate">{`Avatar: ${avatarSourceLabels[user.avatarSource]}`}</Badge> : null}
          </>
        }
        onBack={goBack}
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Services" value={String(user.domains.length)} />
        <Metric label="Organisations" value={String(organisations.filter((org) => org.members.some((member) => member.id === user.id)).length)} />
        <Metric label="Teams" value={String(memberships.length)} />
        <Metric label="Last Login" value={user.lastLogin} />
      </div>
      <SegmentedTabs value={tab} onChange={setTab} options={[{ label: 'Memberships', value: 'memberships' }, { label: 'Profile', value: 'profile' }, { label: 'Security', value: 'security' }, { label: 'Activity', value: 'activity' }]} />
      {tab === 'security' ? <Card className="p-5">
            <Button
              disabled={resetTwoFa.isPending}
              onClick={() =>
                confirm(
                  `Reset 2FA for ${user.email}?`,
                  'They will need to re-enroll before completing a protected login.',
                  async () => {
                    await resetTwoFa.mutateAsync();
                  },
                )
              }
            >
              {resetTwoFa.isPending ? 'Resetting...' : 'Reset 2FA'}
            </Button>
      </Card> : null}
      {tab === 'profile' ?
      <div className="mb-5">
        <div className="mb-4 flex flex-wrap gap-3">{user.domains.map((domain) => <Link state={recordState} key={domain} className="text-sm text-indigo-600" to={`/domains/${encodeURIComponent(domain)}`}>{domain}</Link>)}</div>
        <UserAvatarSection userId={user.id} userName={user.name ?? user.email} />
      </div> : null}
      {tab === 'memberships' ? <>
      {orgsQuery.isError ? <p role="alert">Could not load memberships. <Button onClick={() => void orgsQuery.refetch()}>Retry</Button></p> : null}
      <Card className="mb-4">
        <CardHeader>Organisations</CardHeader>
        <div className="divide-y divide-gray-100">
          {organisations.filter((org) => org.members.some((member) => member.id === user.id)).map((org) => <div className="px-5 py-3" key={org.id}><Link state={recordState} className="text-sm text-indigo-600" to={`/organisations/${org.id}`}>{org.name}</Link></div>)}
        </div>
      </Card>
      <Card>
        <CardHeader>
          <span className="text-sm font-semibold text-gray-900">Teams</span>
        </CardHeader>
        <DataTable headers={['Organisation', 'Team', 'Org Role', 'Team Role', 'Members']}>
          {pageItems.map(({ member, organisation, team }) => (
            <tr
              key={`${organisation.id}-${team.id}`}
              className="cursor-pointer transition-colors hover:bg-gray-50"
              tabIndex={0}
              onClick={() => openRecord(`/organisations/${organisation.id}/teams/${team.id}`)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.target === event.currentTarget) {
                  openRecord(`/organisations/${organisation.id}/teams/${team.id}`);
                }
              }}
            >
              <Td><Link state={recordState} className="font-medium text-indigo-600 hover:text-indigo-900" to={`/organisations/${organisation.id}`} onClick={(event) => event.stopPropagation()}>{organisation.name}</Link></Td>
              <Td>
                <Link state={recordState} className="font-medium text-indigo-600 hover:text-indigo-900" to={`/organisations/${organisation.id}/teams/${team.id}`} onClick={(event) => event.stopPropagation()}>{team.name}</Link>
                {team.isDefault ? <Badge className="ml-2" variant="blue">Default</Badge> : null}
              </Td>
              <Td><StatusBadge status={member.role} /></Td>
              <Td><StatusBadge status={member.teamRoles[team.name] ?? 'member'} /></Td>
              <Td>{team.members}</Td>

            </tr>
          ))}
        {pageItems.length === 0 && !orgsQuery.isError ? <tr><Td colSpan={5}>No teams in the loaded organisation directory.</Td></tr> : null}
        </DataTable>
        <PaginationFooter {...pagination} />
      </Card>
      </> : null}
      {tab === 'activity' ? <Card className="mt-4">
        <CardHeader>
          <span className="text-sm font-semibold text-gray-900">Recent Login Activity</span>
        </CardHeader>
        <div className="divide-y divide-gray-100">
          {logsQuery.isError ? <p role="alert">Could not load login activity. <Button onClick={() => void logsQuery.refetch()}>Retry</Button></p> : null}
          {logsQuery.isLoading ? <p>Loading login activity...</p> : null}
          {recentLogs.slice(0, 5).map((log) => (
            <div key={log.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <span className="text-gray-700">{log.ts}</span>
              <span className="text-xs text-gray-400">{log.domain} · {log.userAgent}</span>
              <Badge variant={log.result === 'ok' ? 'green' : 'red'}>{log.result.toUpperCase()}</Badge>
            </div>
          ))}
          {!logsQuery.isLoading && !logsQuery.isError && recentLogs.length === 0 ? <p className="px-5 py-4 text-sm text-gray-400">No recent logins.</p> : null}
        </div>
      </Card> : null}
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
