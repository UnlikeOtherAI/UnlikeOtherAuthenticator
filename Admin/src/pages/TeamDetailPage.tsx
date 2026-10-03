import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { useDirectoryParam } from '../features/admin/useDirectoryParam';
import { SegmentedTabs } from '../components/ui/Tabs';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { TeamDialog } from '../components/dialogs/TeamDialog';
import { LoginRestrictionSection } from '../components/sections/LoginRestrictionSection';
import { adminService } from '../services/admin-service';
import { useTeamQuery } from '../features/admin/admin-queries';
import { TeamAvatar } from '../features/admin/TeamAvatar';
import { TeamAvatarSection } from '../features/admin/TeamAvatarSection';
import { UserAvatar } from '../features/admin/UserAvatar';

export function TeamDetailPage() {
  const { orgId, teamId } = useParams();
  const { recordState, openRecord, goBack } = useDirectoryNavigation('/organisations');
  const [rawTab, setTab] = useDirectoryParam('tab', 'members');
  const tab = ['profile', 'access'].includes(rawTab) ? rawTab : 'members';
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(false);
  const closeDialog = () => setDialog(false);
  const { data, isLoading, isError, refetch } = useTeamQuery(orgId, teamId);
  const updateRestriction = useMutation({
    mutationFn: (input: { allowedEmailDomains: string[]; allowedEmails: string[] }) =>
      adminService.updateTeam(orgId ?? '', teamId ?? '', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const updateTeamDetails = useMutation({
    mutationFn: (input: { name: string; description: string }) =>
      adminService.updateTeam(orgId ?? '', teamId ?? '', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const teamName = data?.team?.name;
  const members = data?.org && teamName ? data.org.members.filter((member) => member.teams.includes(teamName)) : [];
  const { pageItems, pagination } = usePagination(members);

  if (isError) return <div role="alert">Could not load team. <Button onClick={() => void refetch()}>Retry</Button></div>;

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading team...</p>;
  }

  if (!data?.org || !data.team) {
    return <p className="text-sm text-gray-400">Team not found.</p>;
  }

  const { org, team } = data;

  return (
    <>
      <PageHeader
        title={team.name}
        description={`${org.name} · ${members.length} members`}
        leading={<TeamAvatar label={team.name} size="md" teamId={team.id} />}
        badges={team.isDefault ? <Badge variant="blue">Default</Badge> : null}
        onBack={goBack}
        actions={
          <>
            <Button onClick={() => setDialog(true)}>Edit</Button>
          </>
        }
      />
      <p className="mb-4 text-sm"><Link state={recordState} to={`/organisations/${org.id}`} className="text-indigo-600">{org.name}</Link></p>
      <SegmentedTabs value={tab} onChange={setTab} options={[{ label: 'Members', value: 'members' }, { label: 'Profile', value: 'profile' }, { label: 'Access', value: 'access' }]} />
      {tab === 'profile' ?
      <div className="mb-5">
        <TeamAvatarSection teamId={team.id} teamName={team.name} />
      </div> : null}
      {tab === 'access' ? <div className="mb-5">
        <LoginRestrictionSection
          title="Login access whitelist"
          description="Empty = no restriction. A user may sign in if their email domain OR their exact email is listed. Superusers always bypass."
          allowedEmailDomains={team.allowedEmailDomains}
          allowedEmails={team.allowedEmails}
          onSave={(next) => updateRestriction.mutateAsync(next)}
        />
      </div> : null}
      {tab === 'members' ? <Card>
        <CardHeader>
          <span className="text-sm font-semibold text-gray-900">Members ({members.length})</span>
        </CardHeader>
        <DataTable headers={['User', 'Team Role', '2FA', 'Last Login']}>
          {pageItems.map((member) => (
            <tr
              key={member.id}
              className="cursor-pointer transition-colors hover:bg-gray-50"
              tabIndex={0}
              onClick={() => openRecord(`/users/${member.id}`)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.target === event.currentTarget) {
                  openRecord(`/users/${member.id}`);
                }
              }}
            >
              <Td>
                <div className="flex items-center gap-2">
                  <UserAvatar userId={member.id} label={member.name ?? member.email} />
                  <div>
                    <Link state={recordState} to={`/users/${member.id}`} className="font-medium text-indigo-600" onClick={(event) => event.stopPropagation()}>{member.name ?? member.email}</Link>
                    <p className="text-xs text-gray-400">{member.email}</p>
                  </div>
                </div>
              </Td>
              <Td><StatusBadge status={member.teamRoles[team.name] ?? 'member'} /></Td>
              <Td><Badge variant={member.twofa ? 'green' : 'slate'}>{member.twofa ? '2FA enabled' : '2FA not enrolled'}</Badge></Td>
              <Td className="text-xs text-gray-400">{member.lastLogin}</Td>

            </tr>
          ))}
        {pageItems.length === 0 ? <tr><Td colSpan={4}>No members found.</Td></tr> : null}
        </DataTable>
        <PaginationFooter {...pagination} />
      </Card> : null}
      <TeamDialog
        open={dialog}
        team={team}
        onClose={closeDialog}
        onSave={(values) => updateTeamDetails.mutateAsync(values)}
      />
    </>
  );
}
