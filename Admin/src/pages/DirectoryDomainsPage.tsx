import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Card } from '../components/ui/Card';
import { SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useDomainsQuery } from '../features/admin/admin-queries';

export function DirectoryDomainsPage() {
  const { data = [], isLoading } = useDomainsQuery();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const filteredDomains = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return data.filter((domain) => {
      const matchesQuery = !normalized || [domain.name, domain.label].some((value) => value.toLowerCase().includes(normalized));
      const matchesStatus = status === 'all' || domain.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [data, query, status]);
  const { pageItems, pagination } = usePagination(filteredDomains);

  return (
    <>
      <PageHeader title="Domains" description="Browse organisations, teams, and users for each domain" />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-gray-100 px-4 py-3">
          <label className="block w-64 max-w-full">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Domain</span>
            <TextField placeholder="Search by domain..." type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label className="block w-48 max-w-full">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Status</span>
            <SelectField className="h-9 w-full" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </SelectField>
          </label>
        </div>
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading domains...</p>
        ) : (
          <>
            <DataTable headers={['Domain', 'Organisations', 'Users', 'Status']}>
              {pageItems.map((domain) => (
                <tr
                  key={domain.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                  tabIndex={0}
                  onClick={() => navigate(`/domains/${encodeURIComponent(domain.id)}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      navigate(`/domains/${encodeURIComponent(domain.id)}`);
                    }
                  }}
                >
                  <Td>
                    <p className="font-semibold text-indigo-600">{domain.name}</p>
                    <p className="mt-0.5 text-xs text-gray-400">{domain.label}</p>
                  </Td>
                  <Td>{domain.orgs}</Td>
                  <Td>{domain.users}</Td>
                  <Td><StatusBadge status={domain.status} /></Td>
                </tr>
              ))}
              {pageItems.length === 0 ? (
                <tr>
                  <Td colSpan={4} className="text-sm text-gray-400">No domains match the filters.</Td>
                </tr>
              ) : null}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
    </>
  );
}
