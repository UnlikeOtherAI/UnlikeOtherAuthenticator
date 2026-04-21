import { useMemo, useState } from 'react';

import { AutocompleteSelect } from '../components/ui/AutocompleteSelect';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { PaginationFooter, usePagination } from '../components/ui/Table';
import { useOrganisationsQuery, useTeamsQuery } from '../features/admin/admin-queries';
import { TeamTable } from '../features/admin/TeamTable';

export function TeamsPage() {
  const { data: teams = [], isLoading } = useTeamsQuery();
  const { data: orgs = [] } = useOrganisationsQuery();
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
            <TeamTable teams={pageItems} showOrganisation />
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
    </>
  );
}
