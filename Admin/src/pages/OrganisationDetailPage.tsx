import type { ReactNode } from 'react';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { SegmentedTabs } from '../components/ui/Tabs';
import { AddMemberDialog } from '../components/dialogs/AddMemberDialog';
import { ChangeOrgRoleDialog } from '../components/dialogs/ChangeOrgRoleDialog';
import { EditOrganisationDialog } from '../components/dialogs/EditOrganisationDialog';
import { PreapprovalDialog } from '../components/dialogs/PreapprovalDialog';
import { TeamDialog } from '../components/dialogs/TeamDialog';
import { TransferOwnershipDialog } from '../components/dialogs/TransferOwnershipDialog';
import { LoginRestrictionSection } from '../components/sections/LoginRestrictionSection';
import { adminService } from '../services/admin-service';
import { useOrganisationQuery } from '../features/admin/admin-queries';
import type { OrganisationMember, PreapprovedMember } from '../features/admin/types';
import { TeamTable } from '../features/admin/TeamTable';
import { useAdminUi } from '../features/shell/admin-ui';

type OrgTab = 'teams' | 'members' | 'preapproved';

type DialogState =
  | { kind: 'edit-org' }
  | { kind: 'transfer' }
  | { kind: 'add-team' }
  | { kind: 'add-member' }
  | { kind: 'change-org-role'; member: OrganisationMember }
  | { kind: 'add-preapproval' }
  | { kind: 'edit-preapproval'; preapproval: PreapprovedMember };

export function OrganisationDetailPage() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm, openUser } = useAdminUi();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const closeDialog = () => setDialog(null);
  const { data: org, isLoading } = useOrganisationQuery(orgId);
  const updateRestriction = useMutation({
    mutationFn: (allowedEmailDomains: string[]) =>
      adminService.updateOrganisation(orgId ?? '', { allowedEmailDomains }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const [tab, setTab] = useState<OrgTab>('teams');
  const { pageItems: teamPageItems, pagination: teamPagination } = usePagination(org?.teams ?? []);
  const { pageItems: memberPageItems, pagination: memberPagination } = usePagination(org?.members ?? []);
  const { pageItems: preapprovalPageItems, pagination: preapprovalPagination } = usePagination(org?.preapprovedMembers ?? []);

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
        description={`${org.slug} · Created ${org.created}`}
        leading={<Avatar label={org.name} shape="square" size="md" />}
        badges={<Badge variant="green">Active</Badge>}
        onBack={() => navigate('/organisations')}
        actions={
          <>
            <Button onClick={() => setDialog({ kind: 'edit-org' })}>Edit</Button>
            <Button onClick={() => setDialog({ kind: 'transfer' })}>Transfer Ownership</Button>
            <Button variant="danger" onClick={() => confirm(`Delete ${org.name}?`, 'A production write endpoint is required before this can delete stored organisations.')}>Delete</Button>
          </>
        }
      />
      <div className="mb-5 grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
        <MetricCard label="Owner" value={org.owner.name ?? org.owner.email} action={<button className="text-xs font-medium text-indigo-600 hover:text-indigo-900" type="button" onClick={() => openUser(org.owner.id)}>{org.owner.email}</button>} />
        <MetricCard label="Members" value={String(org.members.length)} />
        <MetricCard label="Teams" value={String(org.teams.length)} />
      </div>
      <div className="mb-5">
        <LoginRestrictionSection
          title="Login email-domain restriction"
          description="Only users whose email domain matches one of these can sign in to this organisation. Empty = no restriction. Superusers always bypass."
          value={org.allowedEmailDomains}
          onSave={(next) => updateRestriction.mutateAsync(next)}
        />
      </div>
      <SegmentedTabs<OrgTab> value={tab} onChange={setTab} options={[{ label: 'Teams', value: 'teams' }, { label: 'Members', value: 'members' }, { label: 'Pre-approved', value: 'preapproved' }]} />
      {tab === 'teams' ? (
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold text-gray-900">Teams</span>
            <Button icon="plus" size="sm" variant="primary" onClick={() => setDialog({ kind: 'add-team' })}>Add Team</Button>
          </CardHeader>
          <TeamTable teams={teamPageItems} showDescription />
          <PaginationFooter {...teamPagination} />
        </Card>
      ) : null}
      {tab === 'members' ? (
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold text-gray-900">Members</span>
            <Button icon="plus" size="sm" variant="primary" onClick={() => setDialog({ kind: 'add-member' })}>Add Member</Button>
          </CardHeader>
          <DataTable headers={['User', 'Role', 'Teams', 'Last Login', 'Actions']}>
            {memberPageItems.map((member) => (
              <tr
                key={member.id}
                className="cursor-pointer transition-colors hover:bg-gray-50"
                tabIndex={0}
                onClick={() => openUser(member.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    openUser(member.id);
                  }
                }}
              >
                <Td>
                  <div className="flex items-center gap-2">
                    <Avatar label={member.name ?? member.email} />
                    <div>
                      <span className="font-medium text-gray-700">{member.name ?? member.email}</span>
                      <p className="text-xs text-gray-400">{member.email}</p>
                    </div>
                  </div>
                </Td>
                <Td><StatusBadge status={member.role} /></Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {member.teams.map((teamName) => {
                      const team = org.teams.find((item) => item.name === teamName);
                      return team ? <Link key={team.id} className="text-xs text-indigo-600 hover:text-indigo-900" to={`/organisations/${org.id}/teams/${team.id}`} onClick={(event) => event.stopPropagation()}>{teamName}</Link> : <span key={teamName}>{teamName}</span>;
                    })}
                  </div>
                </Td>
                <Td className="text-xs text-gray-400">{member.lastLogin}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton tone="amber" onClick={() => setDialog({ kind: 'change-org-role', member })}>Change Role</ActionButton>
                  <ActionDivider />
                  <ActionButton tone="red" onClick={() => confirm(`Remove ${member.name ?? member.email}?`, 'Removes them from all teams in this org.')}>Remove</ActionButton>
                </Td>
              </tr>
            ))}
          </DataTable>
          <PaginationFooter {...memberPagination} />
        </Card>
      ) : null}
      {tab === 'preapproved' ? (
        <Card>
          <CardHeader>
            <div>
              <span className="text-sm font-semibold text-gray-900">Pre-approved Users</span>
              <p className="mt-0.5 text-xs text-gray-400">Email allow-list entries that become members on first verified login.</p>
            </div>
            <Button icon="plus" size="sm" variant="primary" onClick={() => setDialog({ kind: 'add-preapproval' })}>Add Pre-approval</Button>
          </CardHeader>
          <DataTable headers={['Email', 'Target Team', 'Role', 'Method', 'Status', 'Created', 'Actions']}>
            {preapprovalPageItems.map((preapproval) => (
              <tr
                key={preapproval.id}
                className="cursor-pointer transition-colors hover:bg-gray-50"
                tabIndex={0}
                onClick={() => setDialog({ kind: 'edit-preapproval', preapproval })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setDialog({ kind: 'edit-preapproval', preapproval });
                  }
                }}
              >
                <Td><code className="text-xs">{preapproval.email}</code></Td>
                <Td>{preapproval.targetTeam}</Td>
                <Td><StatusBadge status={preapproval.role} /></Td>
                <Td><Badge>{preapproval.method}</Badge></Td>
                <Td><Badge variant={preapproval.status === 'claimed' ? 'green' : 'amber'}>{preapproval.status}</Badge></Td>
                <Td className="text-xs text-gray-400">{preapproval.created}</Td>
                <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                  <ActionButton tone="red" onClick={() => confirm(`Revoke ${preapproval.email}?`, 'This removes the pre-approval entry, not an active user account.')}>Revoke</ActionButton>
                </Td>
              </tr>
            ))}
          </DataTable>
          <PaginationFooter {...preapprovalPagination} />
        </Card>
      ) : null}
      <EditOrganisationDialog open={dialog?.kind === 'edit-org'} organisation={org} onClose={closeDialog} />
      <TransferOwnershipDialog open={dialog?.kind === 'transfer'} organisation={org} onClose={closeDialog} />
      <TeamDialog open={dialog?.kind === 'add-team'} team={null} onClose={closeDialog} />
      <AddMemberDialog open={dialog?.kind === 'add-member'} organisation={org} onClose={closeDialog} />
      <ChangeOrgRoleDialog
        open={dialog?.kind === 'change-org-role'}
        member={dialog?.kind === 'change-org-role' ? dialog.member : null}
        onClose={closeDialog}
      />
      <PreapprovalDialog
        open={dialog?.kind === 'add-preapproval' || dialog?.kind === 'edit-preapproval'}
        organisation={org}
        preapproval={dialog?.kind === 'edit-preapproval' ? dialog.preapproval : null}
        onClose={closeDialog}
      />
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
