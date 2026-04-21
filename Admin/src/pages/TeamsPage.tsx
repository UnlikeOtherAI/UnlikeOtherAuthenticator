import { Link } from 'react-router-dom';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td } from '../components/ui/Table';
import { useOrganisationsQuery, useTeamsQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';

export function TeamsPage() {
  const { data: teams = [], isLoading } = useTeamsQuery();
  const { data: orgs = [] } = useOrganisationsQuery();
  const { confirm } = useAdminUi();

  return (
    <>
      <PageHeader title="Teams" description="All teams across all organisations" />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-gray-100 px-4 py-3">
          <TextField className="w-60" placeholder="Search teams..." type="search" />
          <SelectField>
            <option>All orgs</option>
            {orgs.map((org) => <option key={org.id}>{org.name}</option>)}
          </SelectField>
        </div>
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading teams...</p>
        ) : (
          <>
            <DataTable headers={['Team', 'Organisation', 'Members', 'Actions']}>
              {teams.map((team) => (
                <tr key={team.id} className="transition-colors hover:bg-gray-50">
                  <Td>
                    <Link to={`/organisations/${team.orgId}/teams/${team.id}`} className="font-semibold text-indigo-600 hover:text-indigo-900">{team.name}</Link>
                    {team.isDefault ? <Badge className="ml-2" variant="blue">Default</Badge> : null}
                  </Td>
                  <Td><Link to={`/organisations/${team.orgId}`} className="text-gray-700 hover:text-indigo-700">{team.orgName}</Link></Td>
                  <Td>{team.members}</Td>
                  <Td>
                    <Link className="text-xs font-medium text-indigo-600 hover:text-indigo-900" to={`/organisations/${team.orgId}/teams/${team.id}`}>View</Link>
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
            <PaginationFooter />
          </>
        )}
      </Card>
    </>
  );
}
