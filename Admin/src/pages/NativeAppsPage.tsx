import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, Td } from '../components/ui/Table';
import { useNativeApps } from '../features/admin/native-app-queries';
import { NativeAppDialog } from '../features/admin/NativeAppDialog';
import type { NativeApp } from '../schemas/native-app';

export function NativeAppsPage() {
  const query = useNativeApps();
  const [editing, setEditing] = useState<NativeApp | 'new' | null>(null);
  return <>
    <PageHeader title="Apps" description="Native app sign-in, branding and return URLs"
      actions={<Button icon="plus" variant="primary" onClick={() => setEditing('new')}>Register app</Button>} />
    <Card>{query.isPending ? <p className="p-5">Loading apps…</p> : query.isError ?
      <p role="alert" className="p-5 text-red-600">Could not load apps. <button onClick={() => query.refetch()}>Retry</button></p> :
      !query.data.length ? <p className="p-5 text-gray-500">No apps registered.</p> :
      <DataTable headers={['App', 'Identifier', 'Login methods', 'Status', '']}>
        {query.data.map((app) => <tr key={app.id}>
          <Td><span className="flex items-center gap-3">{app.icon_url ? <img src={app.icon_url} className="h-8 w-8 object-contain" alt="" /> : null}{app.name}</span></Td>
          <Td>{app.identifier}</Td><Td>{app.methods.map((m) => m === 'google' ? 'Google' : 'Email/password').join(', ')}</Td>
          <Td>{app.enabled ? 'Enabled' : 'Disabled'}</Td><Td><Button onClick={() => setEditing(app)}>Edit</Button></Td>
        </tr>)}
      </DataTable>}
    </Card>
    {editing ? <NativeAppDialog app={editing === 'new' ? undefined : editing} close={() => setEditing(null)} /> : null}
  </>;
}
