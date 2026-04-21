import { Link, useNavigate, useParams } from 'react-router-dom';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, Td } from '../components/ui/Table';
import { useTeamQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';

export function TeamDetailPage() {
  const { orgId, teamId } = useParams();
  const navigate = useNavigate();
  const { confirm, openUser } = useAdminUi();
  const { data, isLoading } = useTeamQuery(orgId, teamId);

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading team...</p>;
  }

  if (!data?.org || !data.team) {
    return <p className="text-sm text-gray-400">Team not found.</p>;
  }

  const { org, team } = data;
  const members = org.members.filter((member) => member.teams.includes(team.name));

  return (
    <>
      <Button className="mb-4" icon="back" onClick={() => navigate(`/organisations/${org.id}`)}>Back</Button>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Avatar label={team.name} shape="square" size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold text-gray-900">{team.name}</h1>
            {team.isDefault ? <Badge variant="blue">Default</Badge> : null}
          </div>
          <p className="mt-0.5 text-sm text-gray-500">in <Link to={`/organisations/${org.id}`} className="text-indigo-600 hover:text-indigo-900">{org.name}</Link> · {members.length} members</p>
        </div>
        <div className="flex gap-2">
          <Button>Edit</Button>
          {!team.isDefault ? <Button variant="danger" onClick={() => confirm(`Delete ${team.name}?`, 'Members stay in the organisation.')}>Delete</Button> : null}
        </div>
      </div>
      <Card>
        <CardHeader>
          <span className="text-sm font-semibold text-gray-900">Members ({members.length})</span>
          <Button icon="plus" size="sm" variant="primary">Add Member</Button>
        </CardHeader>
        <DataTable headers={['User', 'Team Role', '2FA', 'Last Login', 'Actions']}>
          {members.map((member) => (
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
              <Td><StatusBadge status={member.teamRoles[team.name] ?? 'member'} /></Td>
              <Td><StatusBadge status={member.twofa ? 'On' : 'Off'} /></Td>
              <Td className="text-xs text-gray-400">{member.lastLogin}</Td>
              <Td>
                <ActionButton onClick={() => openUser(member.id)}>View</ActionButton>
                <ActionDivider />
                <ActionButton tone="amber">Change Role</ActionButton>
                <ActionDivider />
                <ActionButton tone="red" onClick={() => confirm('Remove from team?', `${member.name ?? member.email} will be removed from ${team.name}.`)}>Remove</ActionButton>
              </Td>
            </tr>
          ))}
        </DataTable>
      </Card>
    </>
  );
}
