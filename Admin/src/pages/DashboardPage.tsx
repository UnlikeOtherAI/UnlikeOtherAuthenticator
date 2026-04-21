import { Link } from 'react-router-dom';

import { Badge } from '../components/ui/Badge';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { MethodBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useDashboardQuery } from '../features/admin/admin-queries';

export function DashboardPage() {
  const { data, isLoading } = useDashboardQuery();
  const { pageItems: logPageItems, pagination: logPagination } = usePagination(data?.logs ?? [], 5);

  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">Loading dashboard...</p>;
  }

  const stats = [
    { label: 'Total Users', value: data.stats.users.toLocaleString(), sub: '+23 this week', color: 'text-green-600' },
    { label: 'Active Domains', value: data.stats.domains.toString(), sub: '2 pending setup', color: 'text-gray-500' },
    { label: 'Organisations', value: data.stats.orgs.toString(), sub: 'across 8 domains', color: 'text-blue-600' },
    { label: 'Logins Today', value: data.stats.loginsToday.toString(), sub: '3 failed attempts', color: 'text-amber-600' },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description="System overview and recent activity" />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label} className="p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{stat.label}</p>
            <p className="mt-1 text-3xl font-bold text-gray-900">{stat.value}</p>
            <p className={`mt-0.5 text-xs ${stat.color}`}>{stat.sub}</p>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold text-gray-900">Recent Login Activity</span>
            <Link to="/logs" className="text-xs font-medium text-indigo-600 hover:text-indigo-800">
              View all
            </Link>
          </CardHeader>
          <DataTable headers={['User', 'Domain', 'Method', 'Time']}>
            {logPageItems.map((log) => (
              <tr key={log.id} className="transition-colors hover:bg-gray-50">
                <Td>{log.user ?? <span className="italic text-gray-400">unknown</span>}</Td>
                <Td className="text-xs text-gray-400">{log.domain}</Td>
                <Td>
                  <MethodBadge method={log.method} />
                </Td>
                <Td className="text-xs text-gray-400">recent</Td>
              </tr>
            ))}
          </DataTable>
          <PaginationFooter {...logPagination} />
        </Card>
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold text-gray-900">Alerts</span>
          </CardHeader>
          <div className="divide-y divide-gray-50">
            <AlertRow color="bg-amber-500" title="Secret rotation needed" description="widgets.io secret 89 days old" />
            <AlertRow color="bg-red-500" title="Failed logins" description="3 from 185.220.101.x today" />
            <AlertRow color="bg-blue-500" title="New domain added" description="beta.newproduct.com 2h ago" />
            <AlertRow color="bg-green-500" title="Systems operational" description="DB, email, social OK" />
          </div>
          <div className="border-t border-gray-50 px-4 py-3">
            <Badge variant="green">Mock data ready</Badge>
          </div>
        </Card>
      </div>
    </>
  );
}

function AlertRow({ color, description, title }: { color: string; description: string; title: string }) {
  return (
    <div className="flex gap-2 px-4 py-3">
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${color}`} />
      <div>
        <p className="text-xs font-medium text-gray-900">{title}</p>
        <p className="mt-0.5 text-xs text-gray-400">{description}</p>
      </div>
    </div>
  );
}
