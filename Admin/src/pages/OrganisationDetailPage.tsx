import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, Td } from '../components/ui/Table';
import { SegmentedTabs } from '../components/ui/Tabs';
import { useOrganisationQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';

type OrgTab = 'teams' | 'members';

export function OrganisationDetailPage() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const { confirm, openUser } = useAdminUi();
  const { data: org, isLoading } = useOrganisationQuery(orgId);
  const [tab, setTab] = useState<OrgTab>('teams');

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading organisation...</p>;
  }

  if (!org) {
    return <p className="text-sm text-gray-400">Organisation not found.</p>;
  }

  return (
    <>
      <Button className="mb-4" icon="back" onClick={() => navigate('/organisations')}>Back</Button>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Avatar label={org.name} shape="square" size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold text-gray-900">{org.name}</h1>
            <Badge variant="green">Active</Badge>
          </div>
          <p className="mt-0.5 text-sm text-gray-500">{org.slug} · Created {org.created}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button>Edit</Button>
          <Button>Transfer Ownership</Button>
          <Button variant="danger" onClick={() => confirm(`Delete ${org.name}?`, 'Permanently deletes the org and all teams in the sample UI.')}>Delete</Button>
        </div>
      </div>
      <div className="mb-5 grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
        <MetricCard label="Owner" value={org.owner.name ?? org.owner.email} action={<button className="text-xs font-medium text-indigo-600 hover:text-indigo-900" type="button" onClick={() => openUser(org.owner.id)}>{org.owner.email}</button>} />
        <MetricCard label="Members" value={String(org.members.length)} />
        <MetricCard label="Teams" value={String(org.teams.length)} />
      </div>
      <SegmentedTabs<OrgTab> value={tab} onChange={setTab} options={[{ label: 'Teams', value: 'teams' }, { label: 'Members', value: 'members' }]} />
      {tab === 'teams' ? (
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold text-gray-900">Teams</span>
            <Button icon="plus" size="sm" variant="primary">Add Team</Button>
          </CardHeader>
          <DataTable headers={['Team', 'Description', 'Members', 'Actions']}>
            {org.teams.map((team) => (
              <tr key={team.id} className="transition-colors hover:bg-gray-50">
                <Td>
                  <Link to={`/organisations/${org.id}/teams/${team.id}`} className="font-semibold text-indigo-600 hover:text-indigo-900">{team.name}</Link>
                  {team.isDefault ? <Badge className="ml-2" variant="blue">Default</Badge> : null}
                </Td>
                <Td className="text-xs text-gray-400">{team.description || '—'}</Td>
                <Td>{team.members}</Td>
                <Td>
                  <Link className="text-xs font-medium text-indigo-600 hover:text-indigo-900" to={`/organisations/${org.id}/teams/${team.id}`}>View</Link>
                  <ActionDivider />
                  <ActionButton>Edit</ActionButton>
                  {!team.isDefault ? (
                    <>
                      <ActionDivider />
                      <ActionButton tone="red" onClick={() => confirm(`Delete ${team.name}?`, 'Members stay in the organisation.')}>Delete</ActionButton>
                    </>
                  ) : null}
                </Td>
              </tr>
            ))}
          </DataTable>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold text-gray-900">Members</span>
            <Button icon="plus" size="sm" variant="primary">Add Member</Button>
          </CardHeader>
          <DataTable headers={['User', 'Role', 'Teams', 'Last Login', 'Actions']}>
            {org.members.map((member) => (
              <tr key={member.id} className="transition-colors hover:bg-gray-50">
                <Td>
                  <div className="flex items-center gap-2">
                    <Avatar label={member.name ?? member.email} />
                    <div>
                      <button className="font-medium text-gray-700 hover:text-indigo-700" type="button" onClick={() => openUser(member.id)}>{member.name ?? member.email}</button>
                      <p className="text-xs text-gray-400">{member.email}</p>
                    </div>
                  </div>
                </Td>
                <Td><StatusBadge status={member.role} /></Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {member.teams.map((teamName) => {
                      const team = org.teams.find((item) => item.name === teamName);
                      return team ? <Link key={team.id} className="text-xs text-indigo-600 hover:text-indigo-900" to={`/organisations/${org.id}/teams/${team.id}`}>{teamName}</Link> : <span key={teamName}>{teamName}</span>;
                    })}
                  </div>
                </Td>
                <Td className="text-xs text-gray-400">{member.lastLogin}</Td>
                <Td>
                  <ActionButton onClick={() => openUser(member.id)}>View</ActionButton>
                  <ActionDivider />
                  <ActionButton tone="amber">Change Role</ActionButton>
                  <ActionDivider />
                  <ActionButton tone="red" onClick={() => confirm(`Remove ${member.name ?? member.email}?`, 'Removes them from all teams in this org.')}>Remove</ActionButton>
                </Td>
              </tr>
            ))}
          </DataTable>
        </Card>
      )}
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
