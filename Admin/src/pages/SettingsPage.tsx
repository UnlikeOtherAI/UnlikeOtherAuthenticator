import { useState } from 'react';

import { ActionButton, ActionDivider } from '../components/ui/ActionButton';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { DataTable, Td } from '../components/ui/Table';
import { SegmentedTabs } from '../components/ui/Tabs';
import { useSettingsQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';

type SettingsTab = 'bans' | 'apps' | 'system';

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('bans');

  return (
    <>
      <PageHeader title="Settings" description="System-level controls and template examples" />
      <SegmentedTabs<SettingsTab> value={tab} onChange={setTab} options={[{ label: 'Bans', value: 'bans' }, { label: 'Apps & Flags', value: 'apps' }, { label: 'System', value: 'system' }]} />
      {tab === 'bans' ? <BansSettings /> : null}
      {tab === 'apps' ? <AppsSettings /> : null}
      {tab === 'system' ? <SystemSettings /> : null}
    </>
  );
}

function BansSettings() {
  const { data, isLoading } = useSettingsQuery();
  const { confirm } = useAdminUi();

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
          <Button icon="plus" size="sm" variant="danger">Add</Button>
        </CardHeader>
        <DataTable headers={['Email', 'Banned', 'Reason', '']}>
          {data.bans.emails.map((ban) => (
            <tr key={ban.id}>
              <Td><code>{ban.value}</code></Td>
              <Td className="text-xs text-gray-400">{ban.bannedAt}</Td>
              <Td className="text-xs text-gray-400">{ban.reason}</Td>
              <Td className="text-right"><ActionButton tone="red" onClick={() => confirm(`Remove ${ban.value}?`, 'This only updates the sample UI for now.')}>Remove</ActionButton></Td>
            </tr>
          ))}
        </DataTable>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <span className="text-sm font-semibold text-gray-900">IP Address Bans</span>
            <p className="mt-0.5 text-xs text-gray-400">Single IPs and CIDR ranges</p>
          </div>
          <Button icon="plus" size="sm" variant="danger">Ban IP / Range</Button>
        </CardHeader>
        <DataTable headers={['IP / CIDR', 'Label', 'Banned', 'Hits', 'Expires', '']}>
          {data.bans.ips.map((ban) => (
            <tr key={ban.id}>
              <Td><code className="font-semibold">{ban.value}</code></Td>
              <Td className="text-xs text-gray-400">{ban.label}</Td>
              <Td className="text-xs text-gray-400">{ban.bannedAt}</Td>
              <Td><Badge variant={(ban.hits ?? 0) > 50 ? 'red' : 'amber'}>{ban.hits}</Badge></Td>
              <Td className="text-xs text-gray-400">{ban.expiry ?? 'Permanent'}</Td>
              <Td className="text-right">
                <ActionButton tone="amber">Edit</ActionButton>
                <ActionDivider />
                <ActionButton tone="red">Remove</ActionButton>
              </Td>
            </tr>
          ))}
        </DataTable>
      </Card>
    </div>
  );
}

function AppsSettings() {
  const { data, isLoading } = useSettingsQuery();

  if (isLoading || !data) {
    return <p className="text-sm text-gray-400">Loading apps...</p>;
  }

  return (
    <>
      <Card>
        <DataTable headers={['App', 'Domain', 'Organisation', 'Feature Flags', 'Role Matrix', 'Flags Defined', 'Actions']}>
          {data.apps.map((app) => (
            <tr key={app.id}>
              <Td><p className="font-semibold text-gray-900">{app.name}</p></Td>
              <Td><code>{app.domain}</code></Td>
              <Td className="text-xs text-gray-500">{app.org}</Td>
              <Td><StatusBadge status={app.flagsEnabled ? 'Enabled' : 'Disabled'} /></Td>
              <Td><StatusBadge status={app.matrixEnabled ? 'Enabled' : 'Disabled'} /></Td>
              <Td><span className="font-semibold">{app.flags}</span></Td>
              <Td>
                <ActionButton>Manage Flags</ActionButton>
                <ActionDivider />
                <ActionButton tone="amber">Settings</ActionButton>
                <ActionDivider />
                <ActionButton tone="red">Delete</ActionButton>
              </Td>
            </tr>
          ))}
        </DataTable>
      </Card>
      <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
        <strong>Feature Flags</strong> and <strong>Role Matrix</strong> are shown from the template as mocked admin surfaces. API wiring should replace these rows after the route family is documented.
      </div>
    </>
  );
}

function SystemSettings() {
  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-gray-900">Admin session boundary</p>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">The current panel uses the documented stub interface while the browser-safe production admin session contract is pending. Development bypass is only honored when Vite runs in development mode.</p>
    </Card>
  );
}
