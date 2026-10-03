import { useState } from 'react';
import { Link } from 'react-router';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { RegisterAppDialog } from '../components/dialogs/RegisterAppDialog';
import { useSettingsQuery } from '../features/admin/admin-queries';
import { platformKindLabel } from '../features/admin/platforms';

type DialogState = { kind: 'register-app' };

export function FeatureFlagsPage() {
  const { data, isLoading, isError, refetch } = useSettingsQuery();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const closeDialog = () => setDialog(null);
  const apps = data?.apps ?? [];
  const { pageItems, pagination } = usePagination(apps);

  return (
    <>
      <PageHeader description=""
        title="Feature Flags"
        actions={<Button icon="plus" variant="primary" onClick={() => setDialog({ kind: 'register-app' })}>Register App</Button>}
      />
      <Card>
        {isError ? <p role="alert" className="p-5">Could not load apps. <Button onClick={() => refetch()}>Retry</Button></p> : isLoading || !data ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading apps...</p>
        ) : (
          <>
            <DataTable headers={['App', 'Identifier', 'Service', 'Organisation', 'Flags', 'Kill switches']}>
              {pageItems.map((app) => (
                <tr
                  key={app.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                >
                  <Td>
                    <Link to={`/feature-flags/${app.id}`} className="font-semibold text-indigo-600 hover:underline">{app.name}</Link>
                    <p className="mt-0.5 text-xs text-gray-400">{platformKindLabel(app.platform)}</p>
                  </Td>
                  <Td><code className="text-xs">{app.identifier}</code></Td>
                  <Td><Link to={`/domains/${encodeURIComponent(app.domain)}`} className="text-indigo-600 hover:underline">{app.domain}</Link></Td>
                  <Td className="text-xs text-gray-500">{app.org}</Td>
                  <Td><span className="font-semibold">{app.flags}</span></Td>
                  <Td><Badge variant={app.killSwitches.length ? 'amber' : 'slate'}>{app.killSwitches.length}</Badge></Td>
                </tr>
              ))}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
      <RegisterAppDialog open={dialog?.kind === 'register-app'} onClose={closeDialog} />
    </>
  );
}
