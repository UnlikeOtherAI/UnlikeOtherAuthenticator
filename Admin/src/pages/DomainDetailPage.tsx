import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Avatar } from '../components/ui/Avatar';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { SegmentedTabs } from '../components/ui/Tabs';
import { TeamTable } from '../features/admin/TeamTable';
import { useDomainQuery } from '../features/admin/admin-queries';

type DomainTab = 'organisations' | 'teams' | 'users';

export function DomainDetailPage() {
  const { domainId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useDomainQuery(domainId);
  const [tab, setTab] = useState<DomainTab>('organisations');

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading domain...</p>;
  }

  if (!data) {
    return <p className="text-sm text-gray-400">Domain not found.</p>;
  }

  const { domain, organisations, teams, users } = data;

  return (
    <>
      <PageHeader
        title={domain.name}
        description={domain.label || 'Domain directory'}
        leading={<Avatar label={domain.name} shape="square" size="md" />}
        badges={<StatusBadge status={domain.status} />}
        onBack={() => navigate('/domains')}
      />
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        <MetricCard label="Organisations" value={String(organisations.length)} />
        <MetricCard label="Teams" value={String(teams.length)} />
        <MetricCard label="Users" value={String(users.length)} />
      </div>
      <SegmentedTabs<DomainTab>
        value={tab}
        onChange={setTab}
        options={[
          { label: `Organisations (${organisations.length})`, value: 'organisations' },
          { label: `Teams (${teams.length})`, value: 'teams' },
          { label: `Users (${users.length})`, value: 'users' },
        ]}
      />
      {tab === 'organisations' ? <OrganisationsTab organisations={organisations} /> : null}
      {tab === 'teams' ? <TeamsTab teams={teams} /> : null}
      {tab === 'users' ? <UsersTab users={users} /> : null}
    </>
  );
}

function OrganisationsTab({ organisations }: { organisations: NonNullable<ReturnType<typeof useDomainQuery>['data']>['organisations'] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return organisations;
    return organisations.filter((org) =>
      [org.name, org.slug, org.owner.email, org.owner.name ?? ''].some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [organisations, query]);
  const { pageItems, pagination } = usePagination(filtered);

  return (
    <Card>
      <div className="border-b border-gray-100 px-4 py-3">
        <TextField className="w-64" placeholder="Search organisations..." type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <DataTable headers={['Organisation', 'Owner', 'Members', 'Teams', 'Created']}>
        {pageItems.map((org) => (
          <tr
            key={org.id}
            className="cursor-pointer transition-colors hover:bg-gray-50"
            tabIndex={0}
            onClick={() => navigate(`/organisations/${org.id}`)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                navigate(`/organisations/${org.id}`);
              }
            }}
          >
            <Td>
              <div className="flex items-center gap-2">
                <Avatar label={org.name} shape="square" />
                <div>
                  <Link to={`/organisations/${org.id}`} className="text-sm font-semibold text-indigo-600 hover:text-indigo-900" onClick={(event) => event.stopPropagation()}>{org.name}</Link>
                  <p className="mt-0.5 text-xs text-gray-400">{org.slug}</p>
                </div>
              </div>
            </Td>
            <Td>
              <p className="text-sm text-gray-700">{org.owner.name ?? org.owner.email}</p>
              <p className="text-xs text-gray-400">{org.owner.email}</p>
            </Td>
            <Td>{org.members.length}</Td>
            <Td>{org.teams.length}</Td>
            <Td className="text-xs text-gray-400">{org.created}</Td>
          </tr>
        ))}
        {pageItems.length === 0 ? (
          <tr>
            <Td colSpan={5} className="text-sm text-gray-400">No organisations match the search.</Td>
          </tr>
        ) : null}
      </DataTable>
      <PaginationFooter {...pagination} />
    </Card>
  );
}

function TeamsTab({ teams }: { teams: NonNullable<ReturnType<typeof useDomainQuery>['data']>['teams'] }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return teams;
    return teams.filter((team) =>
      [team.name, team.orgName, team.description].some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [teams, query]);
  const { pageItems, pagination } = usePagination(filtered);

  return (
    <Card>
      <div className="border-b border-gray-100 px-4 py-3">
        <TextField className="w-64" placeholder="Search teams..." type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <TeamTable teams={pageItems} showOrganisation emptyMessage="No teams match the search." />
      <PaginationFooter {...pagination} />
    </Card>
  );
}

function UsersTab({ users }: { users: NonNullable<ReturnType<typeof useDomainQuery>['data']>['users'] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return users;
    return users.filter((user) => [user.name ?? '', user.email].some((value) => value.toLowerCase().includes(normalized)));
  }, [users, query]);
  const { pageItems, pagination } = usePagination(filtered);

  return (
    <Card>
      <div className="border-b border-gray-100 px-4 py-3">
        <TextField className="w-64" placeholder="Search by name or email..." type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <DataTable headers={['User', 'Method', '2FA', 'Last Login', 'Status']}>
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
            <Td><MethodBadge method={user.method} /></Td>
            <Td><StatusBadge status={user.twofa ? 'On' : 'Off'} /></Td>
            <Td className="text-xs text-gray-400">{user.lastLogin}</Td>
            <Td><StatusBadge status={user.status} /></Td>
          </tr>
        ))}
        {pageItems.length === 0 ? (
          <tr>
            <Td colSpan={5} className="text-sm text-gray-400">No users match the search.</Td>
          </tr>
        ) : null}
      </DataTable>
      <PaginationFooter {...pagination} />
    </Card>
  );
}

function MetricCard({ action, label, value }: { action?: ReactNode; label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-gray-900">{value}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </Card>
  );
}
