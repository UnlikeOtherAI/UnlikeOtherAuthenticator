import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useDirectoryParam } from '../features/admin/useDirectoryParam';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';

import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { SegmentedTabs } from '../components/ui/Tabs';
import { LoginRestrictionSection } from '../components/sections/LoginRestrictionSection';
import { adminService } from '../services/admin-service';
import { ApiRequestError } from '../services/api-client';
import { useOrganisationQuery } from '../features/admin/admin-queries';
import type { OrganisationTwoFaPolicy } from '../features/admin/types';
import { TeamTable } from '../features/admin/TeamTable';
import { UserAvatar } from '../features/admin/UserAvatar';
import {
  ORGANISATION_TWOFA_POLICY_OPTIONS,
  TwoFactorPolicySelect,
} from '../features/admin/TwoFactorPolicySelect';
import { useAdminUi } from '../features/shell/admin-ui';

type OrgTab = 'teams' | 'members' | 'invitations' | 'access';

export function OrganisationDetailPage() {
  const { orgId } = useParams();
  const { recordState, openRecord, goBack } = useDirectoryNavigation('/organisations');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm } = useAdminUi();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { data: org, isLoading, isError, refetch } = useOrganisationQuery(orgId);
  const updateRestriction = useMutation({
    mutationFn: (input: { allowedEmailDomains: string[]; allowedEmails: string[] }) =>
      adminService.updateOrganisation(orgId ?? '', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const updateTwoFaPolicy = useMutation({
    mutationFn: (twoFaPolicy: OrganisationTwoFaPolicy) =>
      adminService.updateOrganisation(orgId ?? '', { twoFaPolicy }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const deleteOrganisation = useMutation({
    mutationFn: () => adminService.deleteOrganisation(orgId ?? ''),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      navigate('/organisations');
    },
    onError: (error) => {
      setDeleteError(
        error instanceof ApiRequestError && error.code === 'ORG_HAS_PROTECTED_RECORDS'
          ? 'This organisation has protected billing/commercial records and cannot be deleted'
          : 'The organisation could not be deleted. Try again.',
      );
    },
  });
  const [rawTab, setTab] = useDirectoryParam('tab', 'members');
  const tab: OrgTab = ['teams', 'invitations', 'access'].includes(rawTab) ? rawTab as OrgTab : 'members';
  const { pageItems: teamPageItems, pagination: teamPagination } = usePagination(org?.teams ?? [], 10, { key: 'teamsPage' });
  const { pageItems: memberPageItems, pagination: memberPagination } = usePagination(org?.members ?? [], 10, { key: 'membersPage' });
  const { pageItems: preapprovalPageItems, pagination: preapprovalPagination } = usePagination(org?.preapprovedMembers ?? [], 10, { key: 'invitationsPage' });

  if (isError) return <div role="alert">Could not load organisation. <Button onClick={() => void refetch()}>Retry</Button></div>;

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading organisation...</p>;
  }

  if (!org) {
    return <p className="text-sm text-gray-400">Organisation not found.</p>;
  }

  return (
    <>
      <PageHeader
        title={org.name}
        description={`${org.slug} Â· Created ${org.created}`}
        leading={<Avatar label={org.name} shape="square" size="md" />}
        onBack={goBack}
        actions={
          <>
            <Button
              disabled={deleteOrganisation.isPending}
              variant="danger"
              onClick={() => {
                setDeleteError(null);
                confirm(
                  `Delete ${org.name}?`,
                  'This permanently deletes the organisation and its teams and memberships. User accounts are retained.',
                  async () => {
                    await deleteOrganisation.mutateAsync();
                  },
                  org.name,
                );
              }}
            >
              {deleteOrganisation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </>
        }
      />
      {deleteError ? (
        <p className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {deleteError}
        </p>
      ) : null}
      <div className="mb-5 grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
        <MetricCard label="Owner" value={org.owner.name ?? (org.owner.email || 'Owner unavailable')} action={org.owner.id ? <Link state={recordState} className="text-xs text-indigo-600" to={`/users/${org.owner.id}`}>{org.owner.email}</Link> : undefined} />
        <MetricCard label="Members" value={String(org.members.length)} />
        <MetricCard label="Teams" value={String(org.teams.length)} />
      </div>
      <SegmentedTabs<OrgTab> value={tab} onChange={setTab} options={[{ label: 'Members', value: 'members' }, { label: 'Teams', value: 'teams' }, { label: 'Invitations', value: 'invitations' }, { label: 'Access', value: 'access' }]} />
      {tab === 'access' ? <>
      <div className="mb-5">
        <LoginRestrictionSection
          title="Login access whitelist"
          description="Empty = no restriction. A user may sign in if their email domain OR their exact email is listed. Superusers always bypass."
          allowedEmailDomains={org.allowedEmailDomains}
          allowedEmails={org.allowedEmails}
          onSave={(next) => updateRestriction.mutateAsync(next)}
        />
      </div>
      <div className="mb-5">
        <TwoFactorPolicySelect
          title="Two-factor authentication"
          description="Organisation policy is combined with the service domain policy at login; required always wins."
          value={org.twoFaPolicy}
          options={ORGANISATION_TWOFA_POLICY_OPTIONS}
          saving={updateTwoFaPolicy.isPending}
          onSave={(next) => updateTwoFaPolicy.mutateAsync(next)}
        />
      </div>

      </> : null}
      {tab === 'teams' ? (
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold text-gray-900">Teams</span>
          </CardHeader>
          <TeamTable teams={teamPageItems} showDescription />
          <PaginationFooter {...teamPagination} />
        </Card>
      ) : null}
      {tab === 'members' ? (
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold text-gray-900">Members</span>
          </CardHeader>
          <DataTable headers={['User', 'Role', 'Teams', 'Last Login']}>
            {memberPageItems.map((member) => (
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
                <Td><StatusBadge status={member.role} /></Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {member.teams.map((teamName) => {
                      const team = org.teams.find((item) => item.name === teamName);
                      return team ? <Link state={recordState} key={team.id} className="text-xs text-indigo-600 hover:text-indigo-900" to={`/organisations/${org.id}/teams/${team.id}`} onClick={(event) => event.stopPropagation()}>{teamName}</Link> : <span key={teamName}>{teamName}</span>;
                    })}
                  </div>
                </Td>
                <Td className="text-xs text-gray-400">{member.lastLogin}</Td>

              </tr>
            ))}
          {memberPageItems.length === 0 ? <tr><Td colSpan={4}>No members found.</Td></tr> : null}
          </DataTable>
          <PaginationFooter {...memberPagination} />
        </Card>
      ) : null}
      {tab === 'invitations' ? (
        <Card>
          <CardHeader>
            <div>
              <span className="text-sm font-semibold text-gray-900">Invitations</span>
              <p className="mt-0.5 text-xs text-gray-400">Invitations and their current status.</p>
            </div>
          </CardHeader>
          <DataTable headers={['Email', 'Target Team', 'Role', 'Status', 'Approval', 'Created']}>
            {preapprovalPageItems.map((preapproval) => (
              <tr
                key={preapproval.id}
              >
                <Td><code className="text-xs">{preapproval.email}</code></Td>
                <Td>{preapproval.targetTeamId ? <Link state={recordState} to={`/organisations/${org.id}/teams/${preapproval.targetTeamId}`} className="text-indigo-600">{preapproval.targetTeam}</Link> : preapproval.targetTeam}</Td>
                <Td><StatusBadge status={preapproval.role} /></Td>
                <Td><Badge variant={['claimed', 'accepted'].includes(preapproval.status) ? 'green' : 'amber'}>{preapproval.status}</Badge></Td>
                <Td>{preapproval.approvalStatus?.replaceAll('_', ' ') ?? '—'}</Td>
                <Td className="text-xs text-gray-400">{preapproval.created}</Td>

              </tr>
            ))}
          {preapprovalPageItems.length === 0 ? <tr><Td colSpan={6}>No invitations found.</Td></tr> : null}
          </DataTable>
          <PaginationFooter {...preapprovalPagination} />
        </Card>
      ) : null}
    </>
  );
}

function MetricCard({ action, label, value }: { action?: ReactNode; label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-gray-900">{value}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </Card>
  );
}
