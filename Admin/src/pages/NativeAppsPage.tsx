import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { TextField } from '../components/ui/FormFields';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, Td } from '../components/ui/Table';
import { useNativeApps } from '../features/admin/native-app-queries';
import { NativeAppDialog } from '../features/admin/NativeAppDialog';
import type { NativeApp } from '../schemas/native-app';

export function NativeAppsPage() {
  const query = useNativeApps();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const apps = query.data?.filter((app) => `${app.name} ${app.identifier}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const [editing, setEditing] = useState<NativeApp | 'new' | null>(null);
  return <>
    <PageHeader description="" title="Native apps"
      actions={<Button icon="plus" variant="primary" onClick={() => setEditing('new')}>Register app</Button>} />
    <Card><div className="border-b border-gray-100 p-4"><TextField type="search" aria-label="Search native apps" placeholder="Search native apps…" value={search} onChange={(event) => setParams({ q: event.target.value }, { replace: true })} /></div>{query.isPending ? <p className="p-5">Loading apps…</p> : query.isError ?
      <p role="alert" className="p-5 text-red-600">Could not load apps. <button onClick={() => query.refetch()}>Retry</button></p> :
      !apps.length ? <p className="p-5 text-gray-500">No native apps match this view.</p> :
      <DataTable headers={['App', 'Identifier', 'Login methods', 'Status']}>
        {apps.map((app) => <tr key={app.id}>
          <Td><span className="flex items-center gap-3">{app.icon_url ? <img src={app.icon_url} className="h-8 w-8 object-contain" alt="" /> : null}<Link className="font-medium text-indigo-600 hover:underline" to={`/apps/${encodeURIComponent(app.id)}`}>{app.name}</Link></span></Td>
          <Td>{app.identifier}</Td><Td>{app.methods.map((m) => m === 'google' ? 'Google' : 'Email/password').join(', ')}</Td>
          <Td>{app.enabled ? 'Enabled' : 'Disabled'}</Td>
        </tr>)}
      </DataTable>}
    </Card>
    {editing ? <NativeAppDialog app={editing === 'new' ? undefined : editing} close={() => setEditing(null)} /> : null}
  </>;
}
