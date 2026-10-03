import { Link } from 'react-router';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { QueryError } from '../components/ui/QueryError';
import { MethodBadge } from '../components/ui/Status';
import { DataTable, Td } from '../components/ui/Table';
import { useDashboardQuery } from '../features/admin/admin-queries';
import { activityTime } from '../utils/activity';

export function DashboardPage() {
  const { data, isLoading, isError, refetch } = useDashboardQuery();
  if (isError) return <QueryError retry={refetch} />;
  if (isLoading || !data) return <p role="status" className="text-sm text-gray-500">Loading dashboard...</p>;
  const stats = [
    { label: 'Users', value: data.stats.users, path: '/users' },
    { label: 'Active website services', value: data.stats.domains, path: '/domains?status=active' },
    { label: 'Organisations', value: data.stats.orgs, path: '/organisations' },
    { label: 'Logins today (UTC)', value: data.stats.loginsToday, path: `/logs?from=${new Date().toISOString().slice(0,10)}` },
  ];
  return <>
    <PageHeader title="Dashboard" />
    <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{stats.map((stat) => <Link to={stat.path} key={stat.label} className="rounded-xl focus:outline-2 focus:outline-indigo-600"><Card className="p-4 hover:border-indigo-300"><p className="text-sm text-gray-500">{stat.label}</p><p className="mt-1 text-3xl font-semibold">{stat.value.toLocaleString()}</p></Card></Link>)}</div>
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Card><CardHeader><h2 className="text-sm font-semibold">Recent logins</h2><Link to="/logs" className="text-sm text-indigo-700">View activity</Link></CardHeader>
        <DataTable headers={['User', 'Service', 'Method', 'Time (UTC)']}>{data.logs.slice(0,5).map((log) => <tr key={log.id}><Td>{log.userId ? <Link className="text-indigo-700 hover:underline" to={`/users/${encodeURIComponent(log.userId)}`}>{log.user}</Link> : log.user ?? 'Unknown'}</Td><Td><Link className="text-indigo-700 hover:underline" to={`/domains/${encodeURIComponent(log.domain)}`}>{log.domain}</Link></Td><Td><MethodBadge method={log.method} /></Td><Td>{activityTime(log).replace('T',' ').replace('.000Z','')}</Td></tr>)}{!data.logs.length ? <tr><Td colSpan={4}>No recent logins.</Td></tr> : null}</DataTable>
      </Card>
      <Card><CardHeader><h2 className="text-sm font-semibold">Recent connection errors</h2><Link to="/connection-errors" className="text-sm text-indigo-700">View errors</Link></CardHeader><div className="divide-y divide-gray-100">{data.handshakeErrors.slice(0,3).map((error) => <Link key={error.id} className="block p-4 hover:bg-gray-50" to={`/connection-errors?selected=${encodeURIComponent(error.id)}`}><p className="text-sm font-medium text-red-700">{error.errorCode}</p><p className="mt-1 break-all text-xs text-gray-500">{error.domain}</p></Link>)}{!data.handshakeErrors.length ? <p className="p-4 text-sm text-gray-500">No recent connection errors.</p> : null}</div></Card>
    </div>
  </>;
}
