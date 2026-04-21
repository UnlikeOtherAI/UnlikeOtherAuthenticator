import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AutocompleteSelect } from '../components/ui/AutocompleteSelect';
import { Avatar } from '../components/ui/Avatar';
import { Card } from '../components/ui/Card';
import { SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useDomainsQuery, useUsersQuery } from '../features/admin/admin-queries';

export function UsersPage() {
  const { data: users = [], isLoading } = useUsersQuery();
  const { data: domains = [] } = useDomainsQuery();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDomain, setSelectedDomain] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('all');
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
      <PageHeader title="Users" description="All users across all domains" />
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
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading users...</p>
        ) : (
          <>
            <DataTable headers={['User', 'Domains', 'Method', '2FA', 'Last Login', 'Status']}>
              {pageItems.map((user) => (
                <tr
                  key={user.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                  tabIndex={0}
                  onClick={() => navigate(`/users/${user.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      navigate(`/users/${user.id}`);
                    }
                  }}
                >
                  <Td>
                    <div className="flex items-center gap-2">
                      <Avatar label={user.name ?? user.email} />
                      <div>
                        <span className="font-medium text-gray-700">{user.name ?? user.email}</span>
                        <p className="text-xs text-gray-400">{user.email}</p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {user.domains.map((domain) => <span key={domain} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{domain}</span>)}
                    </div>
                  </Td>
                  <Td><MethodBadge method={user.method} /></Td>
                  <Td><StatusBadge status={user.twofa ? 'On' : 'Off'} /></Td>
                  <Td className="text-xs text-gray-400">{user.lastLogin}</Td>
                  <Td><StatusBadge status={user.status} /></Td>
                </tr>
              ))}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
    </>
  );
}
