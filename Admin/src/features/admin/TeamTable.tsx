import { useNavigate } from 'react-router-dom';

import { Badge } from '../../components/ui/Badge';
import { DataTable, Td } from '../../components/ui/Table';
import type { Team } from './types';

export type TeamTableRow = Team & {
  orgName?: string;
};

type TeamTableProps = {
  emptyMessage?: string;
  showDescription?: boolean;
  showOrganisation?: boolean;
  teams: TeamTableRow[];
};

export function TeamTable({ emptyMessage = 'No teams found.', showDescription = false, showOrganisation = false, teams }: TeamTableProps) {
  const navigate = useNavigate();
  const headers = ['Team', showOrganisation ? 'Organisation' : null, showDescription ? 'Description' : null, 'Members'].filter((header): header is string => Boolean(header));

  return (
    <DataTable headers={headers}>
      {teams.map((team) => (
        <tr
          key={team.id}
          className="cursor-pointer transition-colors hover:bg-gray-50"
          tabIndex={0}
          onClick={() => navigate(`/organisations/${team.orgId}/teams/${team.id}`)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              navigate(`/organisations/${team.orgId}/teams/${team.id}`);
            }
          }}
        >
          <Td>
            <span className="font-semibold text-indigo-600">{team.name}</span>
            {team.isDefault ? <Badge className="ml-2" variant="blue">Default</Badge> : null}
          </Td>
          {showOrganisation ? <Td className="text-gray-700">{team.orgName ?? team.orgId}</Td> : null}
          {showDescription ? <Td className="text-xs text-gray-400">{team.description || '-'}</Td> : null}
          <Td>{team.members}</Td>
        </tr>
      ))}
      {teams.length === 0 ? (
        <tr>
          <Td colSpan={headers.length} className="text-sm text-gray-400">{emptyMessage}</Td>
        </tr>
      ) : null}
    </DataTable>
  );
}
