import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { Link } from 'react-router';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { QueryError } from '../components/ui/QueryError';
import { MethodBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useActivityQuery } from '../features/admin/activity-queries';
import { useListParams } from '../utils/list-params';
import { activityTime, loginCsv } from '../utils/activity';

export function LogsPage() {
  const { recordState } = useDirectoryNavigation('/dashboard');
  const state = useListParams();
  const { data: logs = [], isLoading, isError, refetch } = useActivityQuery(state.get('userId') || undefined);
  const query = state.get('q'); const domain = state.get('domain'); const method = state.get('method');
  const from = state.get('from'); const to = state.get('to');
  const filtered = logs.filter((log) => (!domain || domain === log.domain) && (!method || method === log.method)
    && (!query || [log.user, log.ip, log.domain].some((value) => value?.toLowerCase().includes(query.toLowerCase())))
    && (!from || activityTime(log).slice(0, 10) >= from) && (!to || activityTime(log).slice(0, 10) <= to));
  const { pageItems, pagination } = usePagination(filtered);
  const selected = filtered.find((log) => log.id === state.get('selected'));
  function exportCsv() {
    const url = URL.createObjectURL(new Blob([loginCsv(filtered)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'login-activity.csv'; link.click(); URL.revokeObjectURL(url);
  }
  return <>
    <PageHeader title="Login activity" description="Latest 500 successful logins. Filters and export cover this loaded window. Times are UTC." actions={<Button icon="download" disabled={!filtered.length} onClick={exportCsv}>Export CSV</Button>} />
    <Card className="mb-4 p-4"><div className="flex flex-wrap items-end gap-3">
      <FieldShell label="Search"><TextField type="search" aria-label="Search activity" value={query} onChange={(event) => state.set('q', event.target.value)} /></FieldShell>
      <FieldShell label="From (UTC)"><TextField aria-label="From (UTC)" type="date" value={from} onChange={(event) => state.set('from', event.target.value)} /></FieldShell>
      <FieldShell label="To (UTC)"><TextField aria-label="To (UTC)" type="date" value={to} onChange={(event) => state.set('to', event.target.value)} /></FieldShell>
      <FieldShell label="Service"><SelectField aria-label="Service" value={domain} onChange={(event) => state.set('domain', event.target.value)}><option value="">All services</option>{[...new Set(logs.map((log) => log.domain))].map((value) => <option key={value}>{value}</option>)}</SelectField></FieldShell>
      <FieldShell label="Method"><SelectField aria-label="Method" value={method} onChange={(event) => state.set('method', event.target.value)}><option value="">All methods</option>{[...new Set(logs.map((log) => log.method))].map((value) => <option key={value}>{value}</option>)}</SelectField></FieldShell>
    </div></Card>
    {isError ? <QueryError retry={refetch} /> : <Card>{isLoading ? <p role="status" className="p-5">Loading activity...</p> : <><DataTable headers={['Time (UTC)', 'User', 'Service', 'Method', 'IP address']}>
      {pageItems.map((log) => <tr key={log.id} className={selected?.id === log.id ? 'bg-indigo-50' : 'hover:bg-gray-50'}>
        <Td><Link state={recordState} className="text-indigo-700 hover:underline" to={`?${new URLSearchParams({ ...Object.fromEntries(state.params), selected: log.id })}`}>{activityTime(log).replace('T', ' ').replace('.000Z', '')}</Link></Td>
        <Td>{log.userId ? <Link state={recordState} className="text-indigo-700 hover:underline" to={`/users/${encodeURIComponent(log.userId)}`}>{log.user ?? 'User'}</Link> : log.user ?? 'Unknown'}</Td>
        <Td><Link state={recordState} className="text-indigo-700 hover:underline" to={`/domains/${encodeURIComponent(log.domain)}`}>{log.domain}</Link></Td><Td><MethodBadge method={log.method} /></Td><Td>{log.ip}</Td>
      </tr>)}
      {!pageItems.length ? <tr><Td colSpan={5}>No logins match these filters.</Td></tr> : null}
    </DataTable><PaginationFooter {...pagination} /></>}</Card>}
    {selected ? <Card className="mt-4 p-5"><h2 className="font-semibold">Login event</h2><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">{[['Event ID', selected.id], ['Time (UTC)', activityTime(selected)], ['User agent', selected.userAgent], ['IP address', selected.ip], ['Result', 'Successful login']].map(([label, value]) => <div key={label}><dt className="text-gray-500">{label}</dt><dd className="break-all">{value || 'Not recorded'}</dd></div>)}</dl></Card> : null}
  </>;
}
