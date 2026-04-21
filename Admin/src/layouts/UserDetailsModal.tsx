import { useNavigate } from 'react-router-dom';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { useLogsQuery, useOrganisationsQuery, useUserQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';

export function UserDetailsModal() {
  const navigate = useNavigate();
  const { closeUser, confirm, openDialog, selectedUserId } = useAdminUi();
  const userQuery = useUserQuery(selectedUserId);
  const orgsQuery = useOrganisationsQuery();
  const logsQuery = useLogsQuery();
  const user = userQuery.data;
  const orgMemberships = orgsQuery.data?.filter((org) => org.members.some((member) => member.id === selectedUserId)) ?? [];
  const recentLogs = logsQuery.data?.filter((log) => log.user === user?.email).slice(0, 3) ?? [];

  return (
    <Modal
      isOpen={Boolean(selectedUserId)}
      onClose={closeUser}
      title="User Details"
      footer={
        <>
          {user ? <Button onClick={() => { closeUser(); openDialog({ type: 'edit-user', user }); }}>Edit User</Button> : null}
          {user ? <Button variant="primary" onClick={() => { closeUser(); navigate(`/users/${user.id}`); }}>Open Detail</Button> : null}
          <Button onClick={closeUser}>Close</Button>
        </>
      }
    >
      {user ? (
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <Avatar label={user.name ?? user.email} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-gray-900">{user.name ?? user.email}</p>
              <p className="truncate text-sm text-gray-500">{user.email}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <StatusBadge status={user.status} />
                <StatusBadge status={user.twofa ? 'On' : 'Off'} />
                <MethodBadge method={user.method} />
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <Button size="sm" onClick={() => { closeUser(); openDialog({ type: 'edit-user', user }); }}>Edit User</Button>
              <Button size="sm" onClick={() => { closeUser(); openDialog({ type: 'add-user-to-team', user, organisations: orgsQuery.data ?? [] }); }}>Add to Team</Button>
              {user.twofa ? (
                <Button size="sm" onClick={() => confirm(`Reset 2FA for ${user.email}?`, 'They will need to re-enroll before completing a protected login.')}>
                  Reset 2FA
                </Button>
              ) : null}
              <Button size="sm" variant={user.status === 'banned' ? 'secondary' : 'danger'} onClick={() => confirm(`${user.status === 'banned' ? 'Unban' : 'Ban'} ${user.email}?`, 'This is mocked for now; API wiring will replace the action handler.')}>
                {user.status === 'banned' ? 'Unban' : 'Ban User'}
              </Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Metric label="Registered" value={user.created} />
            <Metric label="Last Login" value={user.lastLogin} />
            <Metric label="Auth Method" value={user.method} />
            <Metric label="Domains" value={user.domains.length > 0 ? user.domains.join(', ') : 'Linked by org'} />
          </div>
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Organisations & Teams</p>
            {orgMemberships.length > 0 ? (
              <div className="space-y-1.5">
                {orgMemberships.map((org) => {
                  const member = org.members.find((item) => item.id === selectedUserId);
                  return (
                    <div key={org.id} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">{org.name}</p>
                        <p className="truncate text-xs text-gray-400">{member?.teams.join(', ')}</p>
                      </div>
                      {member ? <StatusBadge status={member.role} /> : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No organisation memberships in sample data.</p>
            )}
          </section>
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Recent Logins</p>
            {recentLogs.length > 0 ? (
              <div className="space-y-1.5">
                {recentLogs.map((log) => (
                  <div key={log.id} className="flex items-center justify-between gap-2 border-b border-gray-100 py-1.5 text-xs">
                    <span className="min-w-0 truncate text-gray-600">
                      {log.ts} · {log.method} · {log.userAgent}
                    </span>
                    <Badge variant={log.result === 'ok' ? 'green' : 'red'}>{log.result.toUpperCase()}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No recent logs.</p>
            )}
          </section>
        </div>
      ) : (
        <p className="text-sm text-gray-400">Loading user...</p>
      )}
    </Modal>
  );
}

function Avatar({ label }: { label: string }) {
  return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">{initials(label)}</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2">
      <p className="text-[11px] text-gray-400">{label}</p>
      <p className="truncate text-sm font-medium text-gray-900">{value}</p>
    </div>
  );
}

function initials(value: string) {
  return value
    .split(' ')
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
