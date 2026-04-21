import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { ActionButton } from '../components/ui/ActionButton';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { FieldShell, SelectField, TextAreaField, TextField } from '../components/ui/FormFields';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { eligibleUsers, featureFlagNames, groupUserSummary, killSwitchNames, platformCoverage } from '../features/admin/feature-audience';
import { useSettingsQuery, useUsersQuery } from '../features/admin/admin-queries';
import type { AppFlagSummary, FeatureAudienceGroup, UserSummary } from '../features/admin/types';
import { useAdminUi } from '../features/shell/admin-ui';

export function FeatureAudienceGroupPage() {
  const { appId, groupId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useSettingsQuery();
  const { data: users = [] } = useUsersQuery();
  const app = data?.apps.find((item) => item.id === appId);
  const isNew = groupId === 'new';
  const group = isNew ? createNewGroup() : app?.audienceGroups.find((item) => item.id === groupId);

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading group...</p>;
  }

  if (!app) {
    return <p className="text-sm text-gray-400">App not found.</p>;
  }

  if (!group) {
    return <p className="text-sm text-gray-400">Group not found.</p>;
  }

  return <AudienceGroupEditor app={app} group={group} isNew={isNew} users={users} onBack={() => navigate(`/feature-flags/${app.id}`)} />;
}

function AudienceGroupEditor({ app, group, isNew, onBack, users }: { app: AppFlagSummary; group: FeatureAudienceGroup; isNew: boolean; onBack: () => void; users: UserSummary[] }) {
  const { confirm } = useAdminUi();
  const [userMode, setUserMode] = useState<FeatureAudienceGroup['userMode']>(group.userMode);
  const [platformMode, setPlatformMode] = useState<FeatureAudienceGroup['platformMode']>(group.platformMode);
  const [selectedUserIds, setSelectedUserIds] = useState(() => new Set(group.userIds));
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddUserOpen, setIsAddUserOpen] = useState(false);
  const targetUsers = useMemo(() => {
    if (userMode === 'all') {
      return eligibleUsers(app, users);
    }

    return users.filter((user) => selectedUserIds.has(user.id));
  }, [app, selectedUserIds, userMode, users]);
  const filteredUsers = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();

    if (!normalized) {
      return targetUsers;
    }

    return targetUsers.filter((user) => [user.name ?? '', user.email, ...user.domains].some((value) => value.toLowerCase().includes(normalized)));
  }, [searchQuery, targetUsers]);
  const { pageItems, pagination } = usePagination(filteredUsers);

  function removeUser(userId: string) {
    setSelectedUserIds((current) => {
      const next = new Set(current);
      next.delete(userId);
      return next;
    });
  }

  function addUser(userId: string) {
    setSelectedUserIds((current) => new Set(current).add(userId));
    setIsAddUserOpen(false);
  }

  return (
    <>
      <PageHeader
        title={isNew ? 'New Audience Group' : group.name}
        description={`${app.name} - ${app.identifier}`}
        onBack={onBack}
        actions={
          <>
            <Button onClick={() => confirm('Save audience group?', 'A production write endpoint is required before this can change stored audience groups.')}>Save Group</Button>
            <Button variant="primary" onClick={() => setIsAddUserOpen(true)} disabled={userMode === 'all'}>Add User</Button>
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <FieldShell label="Group name">
                <TextField defaultValue={isNew ? '' : group.name} placeholder="Checkout beta testers" />
              </FieldShell>
              <FieldShell label="User coverage">
                <SelectField value={userMode} onChange={(event) => setUserMode(event.target.value as FeatureAudienceGroup['userMode'])}>
                  <option value="selected">Selected users</option>
                  <option value="all">All eligible users</option>
                </SelectField>
              </FieldShell>
              <div className="lg:col-span-2">
                <FieldShell label="Description">
                  <TextAreaField defaultValue={isNew ? '' : group.description} placeholder="Who this group is used to test" rows={3} />
                </FieldShell>
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <span className="text-sm font-semibold text-gray-900">Users</span>
                <p className="mt-0.5 text-xs text-gray-400">{groupUserSummary(app, { ...group, userMode, userIds: Array.from(selectedUserIds) }, users)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <TextField aria-label="Search group users" className="w-64" placeholder="Search group users..." type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
                <Button icon="plus" size="sm" variant="primary" onClick={() => setIsAddUserOpen(true)} disabled={userMode === 'all'}>Add User</Button>
              </div>
            </CardHeader>
            <DataTable headers={['User', 'Domains', 'Method', '2FA', 'Last Login', 'Actions']}>
              {pageItems.map((user) => (
                <tr key={user.id} className="transition-colors hover:bg-gray-50">
                  <Td>
                    <div className="flex items-center gap-2">
                      <Avatar label={user.name ?? user.email} />
                      <div>
                        <span className="font-medium text-gray-700">{user.name ?? user.email}</span>
                        <p className="text-xs text-gray-400">{user.email}</p>
                      </div>
                    </div>
                  </Td>
                  <Td className="text-xs text-gray-500">{user.domains.join(', ')}</Td>
                  <Td><MethodBadge method={user.method} /></Td>
                  <Td><StatusBadge status={user.twofa ? 'On' : 'Off'} /></Td>
                  <Td className="text-xs text-gray-400">{user.lastLogin}</Td>
                  <Td className="whitespace-nowrap">
                    {userMode === 'selected' ? <ActionButton aria-label={`Remove ${user.name ?? user.email}`} tone="red" onClick={() => removeUser(user.id)}>Remove</ActionButton> : <span className="text-xs text-gray-400">All users</span>}
                  </Td>
                </tr>
              ))}
              {pageItems.length === 0 ? (
                <tr>
                  <Td colSpan={6} className="text-sm text-gray-400">No users match this audience.</Td>
                </tr>
              ) : null}
            </DataTable>
            <PaginationFooter {...pagination} />
          </Card>
        </div>
        <div className="space-y-4">
          <ScopeCard title="Platforms" summary={platformCoverage(app, platformMode, group.platformIds)}>
            <FieldShell label="Platform coverage">
              <SelectField value={platformMode} onChange={(event) => setPlatformMode(event.target.value as FeatureAudienceGroup['platformMode'])}>
                <option value="all">All platforms</option>
                <option value="selected">Selected platforms</option>
              </SelectField>
            </FieldShell>
            <CheckboxStack>
              {app.platforms.map((platform) => (
                <CheckboxRow key={platform.id} label={platform.name} defaultChecked={platformMode === 'all' || group.platformIds.includes(platform.id)} disabled={platformMode === 'all'} />
              ))}
            </CheckboxStack>
          </ScopeCard>
          <ScopeCard title="Feature Flags" summary={featureFlagNames(app, group)}>
            <CheckboxStack>
              {app.flagDefinitions.map((flag) => (
                <CheckboxRow key={flag.id} label={flag.key} defaultChecked={group.featureFlagIds.includes(flag.id)} />
              ))}
            </CheckboxStack>
          </ScopeCard>
          <ScopeCard title="Kill Switches" summary={killSwitchNames(app, group)}>
            <CheckboxStack>
              {app.killSwitches.map((killSwitch) => (
                <CheckboxRow key={killSwitch.id} label={killSwitch.name} defaultChecked={group.killSwitchIds.includes(killSwitch.id)} />
              ))}
            </CheckboxStack>
          </ScopeCard>
        </div>
      </div>
      <AddUserModal app={app} isOpen={isAddUserOpen} onAdd={addUser} onClose={() => setIsAddUserOpen(false)} selectedUserIds={selectedUserIds} users={users} />
    </>
  );
}

function AddUserModal({ app, isOpen, onAdd, onClose, selectedUserIds, users }: { app: AppFlagSummary; isOpen: boolean; onAdd: (userId: string) => void; onClose: () => void; selectedUserIds: Set<string>; users: UserSummary[] }) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (isOpen) {
      setQuery('');
    }
  }, [isOpen]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      return [];
    }

    return eligibleUsers(app, users)
      .filter((user) => !selectedUserIds.has(user.id))
      .filter((user) => [user.name ?? '', user.email, ...user.domains].some((value) => value.toLowerCase().includes(normalized)))
      .slice(0, 8);
  }, [app, query, selectedUserIds, users]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add User to Group"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        <FieldShell label="Search users" hint="Search by name, email, or domain. Results are limited to this app's eligible domains.">
          <TextField aria-label="Search users to add" autoFocus placeholder="Start typing a user..." type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </FieldShell>
        <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-100">
          {results.map((user) => (
            <div key={user.id} className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 last:border-b-0">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">{user.name ?? user.email}</p>
                <p className="truncate text-xs text-gray-400">{user.email}</p>
              </div>
              <Button aria-label={`Add ${user.name ?? user.email}`} size="sm" variant="primary" onClick={() => onAdd(user.id)}>Add</Button>
            </div>
          ))}
          {!query.trim() ? <p className="px-3 py-4 text-sm text-gray-400">Start typing to find a user.</p> : null}
          {query.trim() && results.length === 0 ? <p className="px-3 py-4 text-sm text-gray-400">No eligible users matching "{query}" found.</p> : null}
        </div>
      </div>
    </Modal>
  );
}

function ScopeCard({ children, summary, title }: { children: ReactNode; summary: string; title: string }) {
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-900">{title}</p>
          <p className="mt-0.5 text-xs text-gray-400">{summary}</p>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function CheckboxStack({ children }: { children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

function CheckboxRow({ defaultChecked, disabled = false, label }: { defaultChecked: boolean; disabled?: boolean; label: string }) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700">
      <input className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50" type="checkbox" defaultChecked={defaultChecked} disabled={disabled} />
      <span>{label}</span>
    </label>
  );
}

function createNewGroup(): FeatureAudienceGroup {
  return {
    id: 'new',
    name: 'New Audience Group',
    description: '',
    userMode: 'selected',
    userIds: [],
    platformMode: 'all',
    platformIds: [],
    featureFlagIds: [],
    killSwitchIds: [],
    active: true,
    updated: 'Draft',
  };
}
