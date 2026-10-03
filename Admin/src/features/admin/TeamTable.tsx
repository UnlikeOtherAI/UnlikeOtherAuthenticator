import { Link } from 'react-router';
import { useDirectoryNavigation } from './useDirectoryNavigation';

import { Badge } from '../../components/ui/Badge';
import { DataTable, Td } from '../../components/ui/Table';
import { TeamAvatar } from './TeamAvatar';
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
  const { recordState, openRecord } = useDirectoryNavigation('/teams');
  const headers = ['Team', showOrganisation ? 'Organisation' : null, showDescription ? 'Description' : null, 'Members'].filter((header): header is string => Boolean(header));

  return (
    <DataTable headers={headers}>
      {teams.map((team) => (
        <tr
          key={team.id}
          className="cursor-pointer transition-colors hover:bg-gray-50"
          tabIndex={0}
          onClick={() => openRecord(`/organisations/${team.orgId}/teams/${team.id}`)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target === event.currentTarget) {
              openRecord(`/organisations/${team.orgId}/teams/${team.id}`);
            }
          }}
        >
          <Td>
            <div className="flex items-center gap-2">
              <TeamAvatar label={team.name} teamId={team.id} />
              <Link state={recordState} to={`/organisations/${team.orgId}/teams/${team.id}`} onClick={(event) => event.stopPropagation()} className="font-semibold text-indigo-600">{team.name}</Link>
              {team.isDefault ? <Badge variant="blue">Default</Badge> : null}
            </div>
          </Td>
          {showOrganisation ? <Td className="text-gray-700"><Link state={recordState} to={`/organisations/${team.orgId}`} onClick={(event) => event.stopPropagation()} className="text-indigo-600">{team.orgName ?? team.orgId}</Link></Td> : null}
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
