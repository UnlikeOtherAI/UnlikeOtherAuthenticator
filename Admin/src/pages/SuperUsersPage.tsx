import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, Td } from '../components/ui/Table';
import { useSuperuserSearchQuery, useSuperusersQuery } from '../features/admin/admin-queries';
import { adminService } from '../services/admin-service';

export function SuperUsersPage() {
  const queryClient = useQueryClient();
  const { data: superusers = [], isLoading } = useSuperusersQuery();
  const [query, setQuery] = useState('');
  const { data: results = [] } = useSuperuserSearchQuery(query);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'superusers'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'superusers', 'search'] }),
    ]);
  };

  const grant = useMutation({
    mutationFn: adminService.grantSuperuser,
    onSuccess: invalidate,
  });
  const revoke = useMutation({
    mutationFn: adminService.revokeSuperuser,
    onSuccess: async () => {
      setPendingRevoke(null);
      await invalidate();
    },
  });

  return (
    <>
      <PageHeader title="Super-users" description="Manage first-party UOA admin access." />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          {isLoading ? (
            <p className="px-5 py-6 text-sm text-gray-400">Loading super-users...</p>
          ) : (
            <DataTable headers={['User', 'Granted', 'Action']}>
              {superusers.map((user) => (
                <tr key={user.userId}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Avatar label={user.name ?? user.email} />
                      <div>
                        <p className="font-medium text-gray-700">{user.name ?? user.email}</p>
                        <p className="text-xs text-gray-400">{user.email}</p>
                      </div>
                    </div>
                  </Td>
                  <Td className="text-xs text-gray-400">{new Date(user.createdAt).toLocaleString()}</Td>
                  <Td>
                    <Button size="sm" variant="danger" onClick={() => setPendingRevoke(user.userId)}>Revoke</Button>
                  </Td>
                </tr>
              ))}
              {superusers.length === 0 ? (
                <tr><Td colSpan={3} className="text-sm text-gray-400">No super-users found.</Td></tr>
              ) : null}
            </DataTable>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-gray-900">Grant access</h2>
          <TextField className="mt-3" type="search" placeholder="Search users..." value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="mt-3 space-y-2">
            {results.map((user) => (
              <div key={user.userId} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 p-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-700">{user.name ?? user.email}</p>
                  <p className="truncate text-xs text-gray-400">{user.email}</p>
                </div>
                <Button size="sm" variant="primary" disabled={grant.isPending} onClick={() => grant.mutate(user.userId)}>Grant</Button>
              </div>
            ))}
            {query.trim().length > 1 && results.length === 0 ? (
              <p className="text-sm text-gray-400">No eligible users found.</p>
            ) : null}
          </div>
        </Card>
      </div>
      <Modal
        isOpen={Boolean(pendingRevoke)}
        onClose={() => setPendingRevoke(null)}
        title="Revoke super-user access?"
        widthClassName="max-w-sm"
        footer={(
          <>
            <Button onClick={() => setPendingRevoke(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={!pendingRevoke || revoke.isPending}
              onClick={() => {
                if (pendingRevoke) revoke.mutate(pendingRevoke);
              }}
            >
              Revoke access
            </Button>
          </>
        )}
      >
        <p className="text-sm text-gray-500">This revokes Admin access for the selected user.</p>
      </Modal>
    </>
  );
}
