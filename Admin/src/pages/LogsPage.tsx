import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { MethodBadge, StatusBadge } from '../components/ui/Status';
import { DataTable, PaginationFooter, Td } from '../components/ui/Table';
import { useDomainsQuery, useLogsQuery } from '../features/admin/admin-queries';

export function LogsPage() {
  const { data: logs = [], isLoading } = useLogsQuery();
  const { data: domains = [] } = useDomainsQuery();

  return (
    <>
      <PageHeader title="Login Logs" description="All authentication events — 90-day retention" actions={<Button icon="download">Export CSV</Button>} />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <FieldShell label="Date range">
            <div className="flex items-center gap-2">
              <TextField className="w-40" type="date" defaultValue="2026-04-01" />
              <span className="text-gray-300">—</span>
              <TextField className="w-40" type="date" defaultValue="2026-04-07" />
            </div>
          </FieldShell>
          <FieldShell label="Domain">
            <SelectField>
              <option>All domains</option>
              {domains.map((domain) => <option key={domain.id}>{domain.name}</option>)}
            </SelectField>
          </FieldShell>
          <FieldShell label="Method">
            <SelectField>
              <option>All</option>
              <option>email</option>
              <option>google</option>
              <option>github</option>
              <option>apple</option>
            </SelectField>
          </FieldShell>
          <FieldShell label="Result">
            <SelectField>
              <option>All</option>
              <option>OK</option>
              <option>FAIL</option>
            </SelectField>
          </FieldShell>
          <Button variant="primary">Apply</Button>
        </div>
      </Card>
      <Card>
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading logs...</p>
        ) : (
          <>
            <DataTable headers={['Timestamp', 'User', 'Domain', 'Method', 'IP Address', 'User Agent', 'Result']}>
              {logs.map((log) => (
                <tr key={log.id} className="transition-colors hover:bg-gray-50">
                  <Td className="whitespace-nowrap text-xs text-gray-400">{log.ts}</Td>
                  <Td>{log.user ?? <span className="italic text-gray-400">unknown</span>}</Td>
                  <Td className="text-xs text-gray-400">{log.domain}</Td>
                  <Td><MethodBadge method={log.method} /></Td>
                  <Td><code className={log.result === 'fail' ? 'text-red-600' : 'text-gray-500'}>{log.ip}</code></Td>
                  <Td className="max-w-48 truncate text-xs text-gray-400">{log.userAgent}</Td>
                  <Td><StatusBadge status={log.result === 'ok' ? 'OK' : 'FAIL'} /></Td>
                </tr>
              ))}
            </DataTable>
            <PaginationFooter />
          </>
        )}
      </Card>
    </>
  );
}
