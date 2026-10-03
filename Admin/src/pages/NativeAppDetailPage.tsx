import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { NativeAppDialog } from '../features/admin/NativeAppDialog';
import { useNativeApps } from '../features/admin/native-app-queries';

export function NativeAppDetailPage() {
  const { goBack } = useDirectoryNavigation('/apps');
  const { appId } = useParams();
  const query = useNativeApps();
  const [editing, setEditing] = useState(false);
  const app = query.data?.find((item) => item.id === appId);
  if (query.isPending) return <p>Loading app…</p>;
  if (query.isError) return <p role="alert">Could not load app. <Button onClick={() => query.refetch()}>Retry</Button></p>;
  if (!app) return <p>App not found. <Link to="/apps">Return to native apps</Link></p>;
  return <>
    <Button icon="back" variant="ghost" onClick={goBack}>Back</Button>
    <PageHeader title={app.name} description={app.identifier} actions={<Button onClick={() => setEditing(true)}>Edit app</Button>} />
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">Sign-in policy</h2>
        <dl className="space-y-3 text-sm">
          <div><dt className="text-gray-500">Status</dt><dd>{app.enabled ? 'Enabled' : 'Disabled'}</dd></div>
          <div><dt className="text-gray-500">Login methods</dt><dd>{app.methods.map((method) => method === 'google' ? 'Google' : 'Email/password').join(', ')}</dd></div>
          <div><dt className="text-gray-500">Registration</dt><dd>{app.allow_registration ? 'Allowed' : 'Disabled'}</dd></div>
          <div><dt className="text-gray-500">Scopes</dt><dd className="break-words font-mono">{app.scopes.join(' ')}</dd></div>
          <div><dt className="text-gray-500">Revision</dt><dd>{app.revision}</dd></div>
        </dl>
      </Card>
      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">Callbacks</h2>
        <ul className="space-y-2 break-all font-mono text-sm">{app.redirect_uris.map((uri) => <li key={uri}>{uri}</li>)}</ul>
        <h2 className="font-semibold">Branding</h2>
        {app.icon_url ? <img src={app.icon_url} alt={`${app.name} icon`} className="h-16 w-16 object-contain" /> : <p className="text-sm text-gray-500">No icon uploaded.</p>}
        <dl className="space-y-2 text-sm">{[['Primary', app.primary_color], ['Background', app.background_color], ['Text', app.text_color]].map(([name, value]) => <div key={name} className="flex gap-3"><dt>{name}</dt><dd className="font-mono">{value}</dd></div>)}</dl>
      </Card>
    </div>
    {editing ? <NativeAppDialog app={app} close={() => setEditing(false)} /> : null}
  </>;
}
