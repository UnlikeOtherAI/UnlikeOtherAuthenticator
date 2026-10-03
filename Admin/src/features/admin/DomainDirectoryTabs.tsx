import { useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';

import { Badge } from '../../components/ui/Badge';
import { Avatar } from '../../components/ui/Avatar';
import { Card } from '../../components/ui/Card';
import { TextField } from '../../components/ui/FormFields';
import { MethodBadge, StatusBadge } from '../../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import { useDirectoryNavigation } from './useDirectoryNavigation';
import { TeamTable } from './TeamTable';
import { UserAvatar } from './UserAvatar';
import type { DomainDirectoryDetail } from './types';

type Organisations = DomainDirectoryDetail['organisations'];
type Teams = DomainDirectoryDetail['teams'];
type Users = DomainDirectoryDetail['users'];

export function DomainOrganisationsTab({ organisations }: { organisations: Organisations }) {
  const location = useLocation();
  const { recordState } = useDirectoryNavigation('/domains');
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const setQuery = (value: string) => setParams((current) => { const next = new URLSearchParams(current); next.set('q', value); next.delete('page'); return next; }, { replace: true, state: location.state });
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return organisations;
    return organisations.filter((org) =>
      [org.name, org.slug, org.owner?.email ?? '', org.owner?.name ?? ''].some((value) => value.toLowerCase().includes(normalized)),
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
          >
            <Td>
              <div className="flex items-center gap-2">
                <Avatar label={org.name} shape="square" />
                <div>
                  <Link state={recordState} to={`/organisations/${org.id}`} className="text-sm font-semibold text-indigo-600 hover:text-indigo-900" onClick={(event) => event.stopPropagation()}>{org.name}</Link>
                  <p className="mt-0.5 text-xs text-gray-400">{org.slug}</p>
                </div>
              </div>
            </Td>
            <Td>
              {org.owner ? <Link state={recordState} to={`/users/${org.owner.id}`} className="text-indigo-600 hover:underline">{org.owner.name ?? org.owner.email}</Link> : <span>Unavailable</span>}
              <p className="text-xs text-gray-400">{org.owner?.email}</p>
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

export function DomainTeamsTab({ teams }: { teams: Teams }) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const setQuery = (value: string) => setParams((current) => { const next = new URLSearchParams(current); next.set('q', value); next.delete('page'); return next; }, { replace: true, state: location.state });
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

export function DomainUsersTab({ users }: { users: Users }) {
  const location = useLocation();
  const { recordState } = useDirectoryNavigation('/domains');
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const setQuery = (value: string) => setParams((current) => { const next = new URLSearchParams(current); next.set('q', value); next.delete('page'); return next; }, { replace: true, state: location.state });
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
          >
            <Td>
              <div className="flex items-center gap-2">
                <UserAvatar userId={user.id} label={user.name ?? user.email} />
                <div>
                  <Link state={recordState} to={`/users/${user.id}`} className="font-medium text-indigo-600 hover:underline">{user.name ?? user.email}</Link>
                  <p className="text-xs text-gray-400">{user.email}</p>
                </div>
              </div>
            </Td>
            <Td><MethodBadge method={user.method} /></Td>
            <Td><Badge variant={user.twofa ? 'green' : 'slate'}>{user.twofa ? 'Enrolled' : 'Not enrolled'}</Badge></Td>
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
