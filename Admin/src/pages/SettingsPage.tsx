import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { QueryError } from '../components/ui/QueryError';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { BanDialog, type BanKind } from '../components/dialogs/BanDialog';
import { useDeleteBanMutation, useSettingsQuery } from '../features/admin/admin-queries';
import { ConfidentialDelegationsSettings } from '../features/admin/ConfidentialDelegationsSettings';
import { useAdminUi } from '../features/shell/admin-ui';
import { useListParams } from '../utils/list-params';

export function SettingsPage() {
  const location = useLocation();
  return <Navigate replace to={new URLSearchParams(location.search).get('tab') === 'delegations' ? '/delegations' : '/bans'} />;
}
export function DelegationsPage() {
  return <><PageHeader title="Delegation policies" /><ConfidentialDelegationsSettings /></>;
}
export function BansPage() {
  const { data, isLoading, isError, refetch } = useSettingsQuery();
  const { confirm } = useAdminUi();
  const remove = useDeleteBanMutation();
  const [dialog, setDialog] = useState<BanKind | null>(null);
  const state = useListParams(); const kind = state.get('type'); const query = state.get('q');
  const bans = Object.entries(data?.bans ?? {}).flatMap(([type, values]) => values.map((ban) => ({ ...ban, type })));
  const filtered = bans.filter((ban) => (!kind || kind === ban.type) && (!query || [ban.value, ban.label, ban.reason].some((value) => value?.toLowerCase().includes(query.toLowerCase()))));
  const { pageItems, pagination } = usePagination(filtered);
  return <>
    <PageHeader title="Access bans" description="Deny rules override allow lists at login and registration." actions={<div className="flex flex-wrap gap-2">{(['email', 'pattern', 'ip', 'user'] as const).map((type) => <Button key={type} onClick={() => setDialog(type)}>Ban {type === 'ip' ? 'IP' : type}</Button>)}</div>} />
    <Card className="mb-4 flex flex-wrap gap-3 p-4"><FieldShell label="Search bans"><TextField type="search" aria-label="Search bans" value={query} onChange={(event) => state.set('q', event.target.value)} /></FieldShell><FieldShell label="Type"><SelectField aria-label="Ban type" value={kind} onChange={(event) => state.set('type', event.target.value)}><option value="">All types</option>{[['emails','Email'],['patterns','Pattern'],['ips','IP'],['users','User']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</SelectField></FieldShell></Card>
    {isError ? <QueryError retry={refetch} /> : <Card>{isLoading ? <p role="status" className="p-5">Loading bans...</p> : <><DataTable headers={['Value', 'Type', 'Scope', 'Reason', 'Created', 'Actions']}>
      {pageItems.map((ban) => <tr key={ban.id}><Td><code className="break-all">{ban.value}</code></Td><Td>{ban.type}</Td><Td>{ban.label}</Td><Td>{ban.reason || 'Not provided'}</Td><Td>{ban.bannedAt.slice(0,10)}</Td><Td><Button size="sm" onClick={() => confirm(`Remove ban for ${ban.value}?`, `This restores access allowed by other policies in ${ban.label ?? 'this scope'}.`, async () => { await remove.mutateAsync(ban.id); })}>Remove</Button></Td></tr>)}
      {!pageItems.length ? <tr><Td colSpan={6}>No bans match these filters.</Td></tr> : null}
    </DataTable><PaginationFooter {...pagination} /></>}</Card>}
    <BanDialog open={dialog !== null} kind={dialog ?? 'email'} onClose={() => setDialog(null)} />
  </>;
}
