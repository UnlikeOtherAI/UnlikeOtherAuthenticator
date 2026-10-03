import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { QueryError } from '../components/ui/QueryError';
import { DataTable, Td } from '../components/ui/Table';
import { useSuperuserSearchQuery, useSuperusersQuery } from '../features/admin/admin-queries';
import { UserAvatar } from '../features/admin/UserAvatar';
import { useAdminUi } from '../features/shell/admin-ui';
import { adminService } from '../services/admin-service';

export function SuperUsersPage() {
  const { recordState } = useDirectoryNavigation('/dashboard');
  const cache = useQueryClient();
  const { data: superusers = [], isLoading, isError, refetch } = useSuperusersQuery();
  const [query, setQuery] = useState(''); const [grantOpen, setGrantOpen] = useState(false);
  const search = useSuperuserSearchQuery(query);
  const { confirm } = useAdminUi();
  const invalidate = () => cache.invalidateQueries({ queryKey: ['admin', 'superusers'] });
  const grant = useMutation({ mutationFn: adminService.grantSuperuser, onSuccess: invalidate });
  const revoke = useMutation({ mutationFn: adminService.revokeSuperuser, onSuccess: invalidate });
  return <>
    <PageHeader title="Administrators" description="Platform access to this admin panel." actions={<Button icon="plus" variant="primary" onClick={() => setGrantOpen(true)}>Grant access</Button>} />
    {isError ? <QueryError retry={refetch} /> : <Card>{isLoading ? <p role="status" className="p-5">Loading administrators...</p> : <DataTable headers={['User', 'Granted', 'Actions']}>
      {superusers.map((user) => <tr key={user.userId}><Td><div className="flex items-center gap-2"><UserAvatar userId={user.userId} label={user.name ?? user.email} /><div><Link state={recordState} className="font-medium text-indigo-700 hover:underline" to={`/users/${user.userId}`}>{user.name ?? user.email}</Link>{user.name ? <p className="text-xs text-gray-500">{user.email}</p> : null}</div></div></Td><Td>{new Date(user.createdAt).toLocaleString()}</Td><Td><Button size="sm" onClick={() => confirm(`Revoke access for ${user.email}?`, 'This removes platform administrator access. Organisation and team memberships are unchanged.', async () => { await revoke.mutateAsync(user.userId); })}>Revoke access</Button></Td></tr>)}
      {!superusers.length ? <tr><Td colSpan={3}>No administrators found.</Td></tr> : null}
    </DataTable>}</Card>}
    <Modal isOpen={grantOpen} onClose={() => setGrantOpen(false)} title="Grant administrator access">
      <TextField type="search" aria-label="Search eligible users" placeholder="Search users..." value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="mt-3 space-y-2">{search.isFetching ? <p role="status">Searching...</p> : search.isError ? <QueryError retry={search.refetch} /> : (search.data ?? []).map((user) => <div key={user.userId} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 p-2"><div className="min-w-0"><p className="truncate text-sm">{user.name ?? user.email}</p>{user.name ? <p className="truncate text-xs text-gray-500">{user.email}</p> : null}</div><Button size="sm" onClick={() => { setGrantOpen(false); confirm(`Grant access to ${user.email}?`, 'This user will be able to administer identities, integrations, security and billing across the platform.', async () => { await grant.mutateAsync(user.userId); }); }}>Grant access</Button></div>)}{query.trim().length > 1 && !search.isFetching && !search.isError && !search.data?.length ? <p className="text-sm text-gray-500">No eligible users found.</p> : null}</div>
    </Modal>
  </>;
}
