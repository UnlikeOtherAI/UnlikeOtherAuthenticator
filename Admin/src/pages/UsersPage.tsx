import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { Badge } from '../components/ui/Badge';
import { useDirectoryParam } from '../features/admin/useDirectoryParam';
import { useMemo } from 'react';
import { Link } from 'react-router';

import { AutocompleteSelect } from '../components/ui/AutocompleteSelect';
import { Card } from '../components/ui/Card';
import { SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useDomainsQuery, useUsersQuery } from '../features/admin/admin-queries';
import { UserAvatar } from '../features/admin/UserAvatar';

export function UsersPage() {
  const { data: users = [], isLoading, isError, refetch } = useUsersQuery();
  const { data: domains = [] } = useDomainsQuery();
  const { recordState, openRecord } = useDirectoryNavigation('/users');
  const [searchQuery, setSearchQuery] = useDirectoryParam('q');
  const [selectedDomain, setSelectedDomain] = useDirectoryParam('domain', 'all');
  const [selectedStatus, setSelectedStatus] = useDirectoryParam('status', 'all');
  const domainOptions = useMemo(() => domains.map((domain) => ({ label: domain.name, meta: domain.label, value: domain.name })), [domains]);
  const filteredUsers = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return users.filter((user) => {
      const matchesSearch = !normalizedQuery || [user.name ?? '', user.email].some((value) => value.toLowerCase().includes(normalizedQuery));
      const matchesDomain = selectedDomain === 'all' || user.domains.includes(selectedDomain);
      const matchesStatus = selectedStatus === 'all' || user.status === selectedStatus;
      return matchesSearch && matchesDomain && matchesStatus;
    });
  }, [searchQuery, selectedDomain, selectedStatus, users]);
  const { pageItems, pagination } = usePagination(filteredUsers);

  return (
    <>
      <PageHeader title="Users" description="Search the latest 100 users." />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-gray-100 px-4 py-3">
          <label className="block w-64 max-w-full">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">User</span>
            <TextField placeholder="Search by name or email..." type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
          </label>
          <AutocompleteSelect allLabel="All domains" emptyLabel="No domains found." label="Domain" options={domainOptions} placeholder="Search domains..." value={selectedDomain} onChange={setSelectedDomain} />
          <label className="block w-48 max-w-full">
            <span className="mb-1.5 block text-sm font-medium text-gray-700">Status</span>
            <SelectField className="h-9 w-full" value={selectedStatus} onChange={(event) => setSelectedStatus(event.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="banned">Banned</option>
              <option value="disabled">Disabled</option>
            </SelectField>
          </label>
        </div>
        {isError ? <div role="alert" className="p-5">Could not load this directory. <button type="button" className="text-indigo-600" onClick={() => void refetch()}>Retry</button></div> : isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading users...</p>
        ) : (
          <>
            <DataTable headers={['User', 'Domains', 'Method', '2FA', 'Last Login', 'Status']}>
              {pageItems.map((user) => (
                <tr
                  key={user.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                  tabIndex={0}
                  onClick={() => openRecord(`/users/${user.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && event.target === event.currentTarget) {
                      openRecord(`/users/${user.id}`);
                    }
                  }}
                >
                  <Td>
                    <div className="flex items-center gap-2">
                      <UserAvatar userId={user.id} label={user.name ?? user.email} />
                      <div>
                        <Link state={recordState} to={`/users/${user.id}`} onClick={(event) => event.stopPropagation()} className="font-medium text-indigo-600">{user.name ?? user.email}</Link>
                        <p className="text-xs text-gray-400">{user.email}</p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {user.domains.slice(0, 2).map((domain) => <Link state={recordState} key={domain} to={`/domains/${encodeURIComponent(domain)}`} onClick={(event) => event.stopPropagation()} className="text-xs text-indigo-600">{domain}</Link>)}
                      {user.domains.length > 2 ? <span className="text-xs text-gray-500">+{user.domains.length - 2} more</span> : null}
                    </div>
                  </Td>
                  <Td><MethodBadge method={user.method} /></Td>
                  <Td><Badge variant={user.twofa ? 'green' : 'slate'}>{user.twofa ? '2FA enabled' : '2FA not enrolled'}</Badge></Td>
                  <Td className="text-xs text-gray-400">{user.lastLogin}</Td>
                  <Td><StatusBadge status={user.status} /></Td>
                </tr>
              ))}
            {pageItems.length === 0 ? <tr><Td colSpan={6}>No users match these filters.</Td></tr> : null}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
    </>
  );
}
