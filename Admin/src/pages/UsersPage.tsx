import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Avatar } from '../components/ui/Avatar';
import { Card } from '../components/ui/Card';
import { SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td } from '../components/ui/Table';
import { useDomainsQuery, useUsersQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';

export function UsersPage() {
  const { data: users = [], isLoading } = useUsersQuery();
  const { data: domains = [] } = useDomainsQuery();
  const { confirm, openUser } = useAdminUi();

  return (
    <>
      <PageHeader title="Users" description="All users across all domains" />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-gray-100 px-4 py-3">
          <TextField className="w-64" placeholder="Search by name or email..." type="search" />
          <SelectField>
            <option>All domains</option>
            {domains.map((domain) => <option key={domain.id}>{domain.name}</option>)}
          </SelectField>
          <SelectField>
            <option>All statuses</option>
            <option>Active</option>
            <option>Banned</option>
          </SelectField>
        </div>
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading users...</p>
        ) : (
          <>
            <DataTable headers={['User', 'Domains', 'Method', '2FA', 'Last Login', 'Status', 'Actions']}>
              {users.map((user) => (
                <tr key={user.id} className="transition-colors hover:bg-gray-50">
                  <Td>
                    <div className="flex items-center gap-2">
                      <Avatar label={user.name ?? user.email} />
                      <div>
                        <button className="font-medium text-gray-700 hover:text-indigo-700 disabled:text-gray-400" type="button" onClick={() => openUser(user.id)}>{user.name ?? user.email}</button>
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
                  <Td>
                    <ActionButton onClick={() => openUser(user.id)}>View</ActionButton>
                    <ActionDivider />
                    {user.twofa ? (
                      <>
                        <ActionButton tone="amber" onClick={() => confirm(`Reset 2FA for ${user.email}?`, 'They will need to re-enroll.')}>Reset 2FA</ActionButton>
                        <ActionDivider />
                      </>
                    ) : null}
                    {user.status === 'banned' ? (
                      <ActionButton tone="green">Unban</ActionButton>
                    ) : (
                      <ActionButton tone="red" onClick={() => confirm(`Ban ${user.email}?`, 'Blocks access to all services in the sample UI.')}>Ban</ActionButton>
                    )}
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
