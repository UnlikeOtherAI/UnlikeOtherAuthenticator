import { useNavigate } from 'react-router-dom';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useSettingsQuery } from '../features/admin/admin-queries';
import { platformKindLabel } from '../features/admin/platforms';
import { useAdminUi } from '../features/shell/admin-ui';

export function FeatureFlagsPage() {
  const { data, isLoading } = useSettingsQuery();
  const { confirm, openDialog } = useAdminUi();
  const navigate = useNavigate();
  const apps = data?.apps ?? [];
  const { pageItems, pagination } = usePagination(apps);

  return (
    <>
      <PageHeader
        title="Feature Flags"
        description="Apps, platforms, feature flags, audience groups, and versioned kill switches"
        actions={<Button icon="plus" variant="primary" onClick={() => openDialog({ type: 'register-app' })}>Register App</Button>}
      />
      <Card>
        {isLoading || !data ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading apps...</p>
        ) : (
          <>
            <DataTable headers={['App', 'Identifier', 'Domain', 'Organisation', 'Platforms', 'Flags', 'Kill Switches', 'Actions']}>
              {pageItems.map((app) => (
                <tr
                  key={app.id}
                  className="cursor-pointer transition-colors hover:bg-gray-50"
                  tabIndex={0}
                  onClick={() => navigate(`/feature-flags/${app.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      navigate(`/feature-flags/${app.id}`);
                    }
                  }}
                >
                  <Td>
                    <p className="font-semibold text-indigo-600">{app.name}</p>
                    <p className="mt-0.5 text-xs text-gray-400">{platformKindLabel(app.platform)}</p>
                  </Td>
                  <Td><code className="text-xs">{app.identifier}</code></Td>
                  <Td><code>{app.domain}</code></Td>
                  <Td className="text-xs text-gray-500">{app.org}</Td>
                  <Td><Badge variant="blue">{app.platforms.length}</Badge></Td>
                  <Td><span className="font-semibold">{app.flags}</span></Td>
                  <Td><Badge variant={app.killSwitches.length ? 'amber' : 'slate'}>{app.killSwitches.length}</Badge></Td>
                  <Td className="whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                    <ActionButton tone="amber" onClick={() => openDialog({ type: 'app-settings', app })}>Settings</ActionButton>
                    <ActionDivider />
                    <ActionButton tone="red" onClick={() => confirm(`Delete ${app.name}?`, 'This removes the app registration in the sample UI.')}>Delete</ActionButton>
                  </Td>
                </tr>
              ))}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
    </>
  );
}
