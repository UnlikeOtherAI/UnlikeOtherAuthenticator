import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { AutocompleteSelect } from '../components/ui/AutocompleteSelect';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useOrganisationsQuery, useTeamsQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';

export function TeamsPage() {
  const { data: teams = [], isLoading } = useTeamsQuery();
  const { data: orgs = [] } = useOrganisationsQuery();
  const navigate = useNavigate();
  const { confirm, openDialog } = useAdminUi();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrgId, setSelectedOrgId] = useState('all');
  const filteredTeams = useMemo(() => {
    const byOrg = selectedOrgId === 'all' ? teams : teams.filter((team) => team.orgId === selectedOrgId);
    const normalizedQuery = searchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return byOrg;
    }

    return byOrg.filter((team) => [team.name, team.orgName, team.description].some((value) => value.toLowerCase().includes(normalizedQuery)));
  }, [searchQuery, selectedOrgId, teams]);
  const orgOptions = useMemo(() => orgs.map((org) => ({ label: org.name, meta: `${org.members.length} members · ${org.teams.length} teams`, value: org.id })), [orgs]);
  const { pageItems, pagination } = usePagination(filteredTeams);

  return (
    <>
      <PageHeader title="Teams" description="All teams across all organisations" />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-gray-100 px-4 py-3">
          <label className="block w-60 max-w-full">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Team</span>
            <TextField placeholder="Search teams..." type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
          </label>
          <AutocompleteSelect label="Organisation" options={orgOptions} placeholder="Search organisations..." value={selectedOrgId} onChange={setSelectedOrgId} />
        </div>
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading teams...</p>
        ) : (
          <>
            <DataTable headers={['Team', 'Organisation', 'Members', 'Actions']}>
              {pageItems.map((team) => {
                const org = orgs.find((item) => item.id === team.orgId);

                return (
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
                    <Link to={`/organisations/${team.orgId}/teams/${team.id}`} className="font-semibold text-indigo-600 hover:text-indigo-900" onClick={(event) => event.stopPropagation()}>{team.name}</Link>
                    {team.isDefault ? <Badge className="ml-2" variant="blue">Default</Badge> : null}
                  </Td>
                  <Td><Link to={`/organisations/${team.orgId}`} className="text-gray-700 hover:text-indigo-700" onClick={(event) => event.stopPropagation()}>{team.orgName}</Link></Td>
                  <Td>{team.members}</Td>
                  <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                    {org ? <ActionButton onClick={() => openDialog({ type: 'edit-team', organisation: org, team })}>Edit</ActionButton> : null}
                    {!team.isDefault ? (
                      <>
                        <ActionDivider />
                        <ActionButton tone="red" onClick={() => confirm(`Delete ${team.name}?`, 'Members stay in the organisation.')}>Delete</ActionButton>
                      </>
                    ) : null}
                  </Td>
                </tr>
              );
              })}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
    </>
  );
}
