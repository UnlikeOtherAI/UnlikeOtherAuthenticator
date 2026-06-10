import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Avatar } from '../../components/ui/Avatar';
import { Card } from '../../components/ui/Card';
import { TextField } from '../../components/ui/FormFields';
import { MethodBadge, StatusBadge } from '../../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../../components/ui/Table';
import { TeamTable } from './TeamTable';
import type { DomainDirectoryDetail } from './types';

type Organisations = DomainDirectoryDetail['organisations'];
type Teams = DomainDirectoryDetail['teams'];
type Users = DomainDirectoryDetail['users'];

export function DomainOrganisationsTab({ organisations }: { organisations: Organisations }) {
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

export function DomainTeamsTab({ teams }: { teams: Teams }) {
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

export function DomainUsersTab({ users }: { users: Users }) {
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
