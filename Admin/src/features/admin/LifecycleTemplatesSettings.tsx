import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { createApiClient } from '../../services/api-client';
import type { LifecycleScope, LifecycleTemplate } from './EntityLifecyclePanel';

const api = createApiClient();
const empty = { scope: 'USER' as LifecycleScope, title: '', message: '', enabled: true };
export function LifecycleTemplatesSettings() {
  const client = useQueryClient();
  const templates = useQuery({ queryKey: ['admin', 'lifecycle-templates'], queryFn: () => api.get<{ data: LifecycleTemplate[] }>('/internal/admin/lifecycle/templates') });
  const [form, setForm] = useState<typeof empty & { id?: string }>(empty);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function save() {
    setPending(true); setError('');
    try { await api.post('/internal/admin/lifecycle/templates', form); await client.invalidateQueries({ queryKey: ['admin', 'lifecycle-templates'] }); setForm(empty); }
    catch { setError('Could not save the reason template. Try again.'); }
    finally { setPending(false); }
  }
  return <Card>
    <CardHeader><div><h2>Lifecycle reason templates</h2><p className="text-sm text-gray-600">Customer text is saved with its revision when access is disabled. Internal notes remain separate.</p></div></CardHeader>
    <div className="space-y-3 p-5">
      {error ? <p role="alert">{error}</p> : null}
      {templates.isError ? <p role="alert">Could not load templates.</p> : null}
      <ul>{templates.data?.data.map(t => <li key={t.id}><Button disabled={pending} onClick={() => setForm({ id: t.id, scope: t.scope, title: t.title, message: t.message, enabled: t.enabled })}>{t.scope}: {t.title} (revision {t.revision}, {t.enabled ? 'enabled' : 'disabled'})</Button></li>)}</ul>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label className="block">Scope <select value={form.scope} disabled={pending || Boolean(form.id)} onChange={e => setForm({ ...form, scope: e.target.value as LifecycleScope })}><option value="USER">User</option><option value="ORGANISATION">Organisation</option><option value="TEAM">Team</option></select></label>
        <label className="block">Title <input className="rounded border p-2" required maxLength={120} value={form.title} disabled={pending} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
        <label className="block">Customer reason<textarea className="block w-full rounded border p-2" required maxLength={2000} value={form.message} disabled={pending} onChange={e => setForm({ ...form, message: e.target.value })} /></label>
        <label className="block"><input type="checkbox" checked={form.enabled} disabled={pending} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Enabled for new disable actions</label>
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save template'}</Button> <Button disabled={pending} onClick={() => setForm(empty)}>New template</Button>
      </form>
    </div>
  </Card>;
}
