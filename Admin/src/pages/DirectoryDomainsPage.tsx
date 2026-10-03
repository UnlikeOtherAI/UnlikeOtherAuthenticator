import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { useDomainsQuery } from '../features/admin/admin-queries';

export function DirectoryDomainsPage() {
  const { data = [], isLoading, isError, refetch } = useDomainsQuery();
  const { recordState } = useDirectoryNavigation('/domains');
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const status = params.get('status') ?? 'active';
  function filter(key: string, value: string) {
    setParams((current) => { const next = new URLSearchParams(current); next.set(key, value); next.delete('page'); return next; }, { replace: true });
  }
  const filteredDomains = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return data.filter((domain) => {
      const matchesQuery =
        !normalized || [domain.label, domain.name].some((value) => value.toLowerCase().includes(normalized));
      const matchesStatus = status === 'all' || domain.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [data, query, status]);
  const { pageItems, pagination } = usePagination(filteredDomains);

  return (
    <>
      <PageHeader
        title="Website services"
        description="Registered client services — secrets, access, signing keys, and their organisations, teams, and users."
      />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-gray-100 px-4 py-3">
          <label className="block w-64 max-w-full">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Service</span>
            <TextField placeholder="Search by service or domain..." type="search" value={query} onChange={(event) => filter('q', event.target.value)} />
          </label>
          <label className="block w-48 max-w-full">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Status</span>
            <SelectField className="h-9 w-full" value={status} onChange={(event) => filter('status', event.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </SelectField>
          </label>
        </div>
        {isError ? <p role="alert" className="p-5">Could not load services. <button onClick={() => refetch()}>Retry</button></p> : isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading domains...</p>
        ) : (
          <>
            <DataTable headers={['Service', 'Secret Age', 'Orgs', 'Users', 'Status']}>
              {pageItems.map((domain) => (
                <tr
                  key={domain.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                >
                  <Td>
                    <Link state={recordState} className="font-semibold text-indigo-600 hover:underline" to={`/domains/${encodeURIComponent(domain.id)}`}>{domain.label || domain.name}</Link>
                    {domain.label && domain.label !== domain.name ? (
                      <p className="mt-0.5 text-xs text-gray-400">{domain.name}</p>
                    ) : null}
                  </Td>
                  <Td>
                    {domain.secretAge ? (
                      <Badge variant={domain.secretOld ? 'amber' : 'green'}>{domain.secretAge}</Badge>
                    ) : (
                      <Badge>—</Badge>
                    )}
                  </Td>
                  <Td>{domain.orgs}</Td>
                  <Td>{domain.users}</Td>
                  <Td><StatusBadge status={domain.status} /></Td>
                </tr>
              ))}
              {pageItems.length === 0 ? (
                <tr>
                  <Td colSpan={5} className="text-sm text-gray-400">No services match the filters.</Td>
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
