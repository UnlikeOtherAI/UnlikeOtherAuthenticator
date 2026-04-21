import { useState } from 'react';

import { ActionButton } from '../components/ui/ActionButton';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { SegmentedTabs } from '../components/ui/Tabs';
import { useSettingsQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';

type SettingsTab = 'bans' | 'system';

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('bans');

  return (
    <>
      <PageHeader title="Settings" description="System-level controls and template examples" />
      <SegmentedTabs<SettingsTab> value={tab} onChange={setTab} options={[{ label: 'Bans', value: 'bans' }, { label: 'System', value: 'system' }]} />
      {tab === 'bans' ? <BansSettings /> : null}
      {tab === 'system' ? <SystemSettings /> : null}
    </>
  );
}

function BansSettings() {
  const { data, isLoading } = useSettingsQuery();
  const { confirm, openDialog } = useAdminUi();
  const { pageItems: emailBanPageItems, pagination: emailBanPagination } = usePagination(data?.bans.emails ?? []);
  const { pageItems: ipBanPageItems, pagination: ipBanPagination } = usePagination(data?.bans.ips ?? []);

  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">Loading settings...</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div>
            <span className="text-sm font-semibold text-gray-900">Banned Emails</span>
            <p className="mt-0.5 text-xs text-gray-400">Exact email address blocks</p>
          </div>
          <Button icon="plus" size="sm" variant="danger" onClick={() => openDialog({ type: 'add-ban', kind: 'email' })}>Add</Button>
        </CardHeader>
        <DataTable headers={['Email', 'Banned', 'Reason', '']}>
          {emailBanPageItems.map((ban) => (
            <tr key={ban.id} className="cursor-pointer hover:bg-gray-50" tabIndex={0} onClick={() => openDialog({ type: 'edit-ban', kind: 'email', ban })}>
              <Td><code>{ban.value}</code></Td>
              <Td className="text-xs text-gray-400">{ban.bannedAt}</Td>
              <Td className="text-xs text-gray-400">{ban.reason}</Td>
              <Td className="text-right" onClick={(event) => event.stopPropagation()}>
                <ActionButton tone="red" onClick={() => confirm(`Remove ${ban.value}?`, 'A production write endpoint is required before this can remove stored bans.')}>Remove</ActionButton>
              </Td>
            </tr>
          ))}
        </DataTable>
        <PaginationFooter {...emailBanPagination} />
      </Card>
      <Card>
        <CardHeader>
          <div>
            <span className="text-sm font-semibold text-gray-900">IP Address Bans</span>
            <p className="mt-0.5 text-xs text-gray-400">Single IPs and CIDR ranges</p>
          </div>
          <Button icon="plus" size="sm" variant="danger" onClick={() => openDialog({ type: 'add-ban', kind: 'ip' })}>Ban IP / Range</Button>
        </CardHeader>
        <DataTable headers={['IP / CIDR', 'Label', 'Banned', 'Hits', 'Expires', '']}>
          {ipBanPageItems.map((ban) => (
            <tr key={ban.id} className="cursor-pointer hover:bg-gray-50" tabIndex={0} onClick={() => openDialog({ type: 'edit-ban', kind: 'ip', ban })}>
              <Td><code className="font-semibold">{ban.value}</code></Td>
              <Td className="text-xs text-gray-400">{ban.label}</Td>
              <Td className="text-xs text-gray-400">{ban.bannedAt}</Td>
              <Td><Badge variant={(ban.hits ?? 0) > 50 ? 'red' : 'amber'}>{ban.hits}</Badge></Td>
              <Td className="text-xs text-gray-400">{ban.expiry ?? 'Permanent'}</Td>
              <Td className="text-right" onClick={(event) => event.stopPropagation()}>
                <ActionButton tone="red">Remove</ActionButton>
              </Td>
            </tr>
          ))}
        </DataTable>
        <PaginationFooter {...ipBanPagination} />
      </Card>
    </div>
  );
}

function SystemSettings() {
  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-gray-900">Admin session boundary</p>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">Admin sessions are issued by the authentication service and stored in browser session storage. Development bypass is only honored when Vite runs in development mode.</p>
    </Card>
  );
}
