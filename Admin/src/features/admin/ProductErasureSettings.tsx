import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { ApiRequestError, createApiClient } from '../../services/api-client';

const path = '/internal/admin/product-erasure';
const api = createApiClient();
const empty = { id: '', name: '', domains: '', nativeApps: '', settings: '', disclosure: '', mode: 'PERSONAL', enabled: false, revision: 0 };
type Form = typeof empty;
type Policy = Omit<Form, 'domains'|'nativeApps'|'settings'> & { domains: string[]; nativeApps: string[]; settings: string[] };
type Pending = { id: string; policyId: string; createdAt: string; requestedContainer?: { scope: string; name: string }; containerJobId?: string; receipts: { domainId: string; acknowledgedAt?: string }[] };
const fields = [
  ['id', 'Product identifier'], ['name', 'Product name'], ['domains', 'Registered backend domains (comma separated)'],
  ['nativeApps', 'Registered native app identifiers (comma separated)'], ['settings', 'Product-owned setting keys (namespace/key, comma separated)'],
] as const;
function list(value: string) { return value.split(',').map(v => v.trim()).filter(Boolean); }

export function ProductErasureSettings() {
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);
  const query = useQuery({ queryKey: ['admin', 'product-erasure', after], queryFn: () =>
    api.get<{ policies: Policy[]; pending: Pending[]; next?: string }>(after ? path + '?after=' + encodeURIComponent(after) : path) });
  const next = query.data?.next;
  const [form, setForm] = useState<Form>(empty);
  const [review, setReview] = useState<Pending>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function edit(policy?: Policy) {
    setForm(policy ? { id: policy.id, revision: policy.revision, name: policy.name, mode: policy.mode, disclosure: policy.disclosure, enabled: policy.enabled, domains: policy.domains.join(', '), nativeApps: policy.nativeApps.join(', '), settings: policy.settings.join(', ') } : empty);
    setEditing(true); setError('');
  }
  async function decide(decision: 'approve' | 'preserve') {
    if (!review) return;
    setBusy(true); setError('');
    try { await api.post(path + '/' + review.id + '/container', { decision }); setReview(undefined); await query.refetch(); }
    catch { setError('Could not apply the decision. Refresh the inventory and review again.'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try {
      await api.post(path, { ...form, domains: list(form.domains), nativeApps: list(form.nativeApps), settings: list(form.settings) });
      await query.refetch(); setEditing(false);
    } catch (e) { setError(e instanceof ApiRequestError && e.code ? e.code.replaceAll('_',' ').toLowerCase() : 'Could not save the deletion policy.'); }
    finally { setBusy(false); }
  }
  return <Card className="mt-5 space-y-4 p-5">
    <h2 className="text-lg font-semibold">Product account deletion</h2>
    {query.isPending ? <p role="status">Loading deletion policies…</p> : query.isError ?
      <p role="alert">Could not load policies. <button onClick={() => void query.refetch()}>Retry</button></p> : <>
      {query.data.policies.map(p => <div className="flex flex-wrap items-center gap-3" key={p.id}>
        <Button onClick={() => edit(p)}>{p.name}</Button><span>{p.enabled ? 'Enabled' : 'Disabled'} · Revision {p.revision}</span>
        {p.enabled && <a className="underline" href={'/auth/delete-account?product=' + encodeURIComponent(p.id)}>Deletion form</a>}</div>)}
      <Button onClick={() => edit()}>Add product policy</Button>
      {query.data.pending.length > 0 && <section><h3>Awaiting cleanup</h3><ul>{query.data.pending.map(j => <li key={j.id}>
        {j.policyId} · {j.createdAt.slice(0,10)} · {j.receipts.filter(r => !r.acknowledgedAt).length} outstanding acknowledgements · {j.id}
        {j.containerJobId ? <a className="underline" href={'/admin/deletion-jobs/' + j.containerJobId}>Open container job</a> :
          j.requestedContainer && <Button onClick={() => { setReview(j); setError(''); }}>Review {j.requestedContainer.name}</Button>}
        {j.receipts.some(r => !r.acknowledgedAt) && <p>Waiting for backend IDs {j.receipts.filter(r => !r.acknowledgedAt).map(r => r.domainId).join(', ')}</p>}
      </li>)}</ul></section>}
      {after && <Button onClick={() => setCursors(cursors.slice(0, -1))}>Previous requests</Button>}
      {next && <Button onClick={() => setCursors([...cursors, next])}>More requests</Button>}
    </>}
    {review && <section className="space-y-3"><h3>Review permanent deletion of {review.requestedContainer?.scope.toLowerCase()} {review.requestedContainer?.name}</h3>
      <p>Verify that all connected products are in the inventory and no other person or product depends on this workspace. Preserving the workspace allows personal erasure to finish.</p>
      <Button disabled={busy} onClick={() => void decide('approve')}>Confirm container deletion</Button> <Button disabled={busy} onClick={() => void decide('preserve')}>Preserve container</Button>
      {error && <p role="alert">{error}</p>}</section>}
    {editing && <form className="max-w-2xl space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
      {fields.map(([key, label]) => <FieldShell key={key} label={label}><TextField aria-label={label} value={form[key]}
        required={key === 'id' || key === 'name'} disabled={busy || (key === 'id' && form.revision > 0)}
        onChange={e => setForm({ ...form, [key]: e.target.value })} /></FieldShell>)}
      <FieldShell label="Deletion policy"><SelectField aria-label="Deletion policy" value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })}>
        <option value="PERSONAL">Erase personal product data</option><option value="ORGANISATION">Preserve shared organisation records</option></SelectField></FieldShell>
      <label className="block">What is erased, what is retained, and when deletion finishes
        <textarea required maxLength={2000} className="block w-full rounded border p-2" value={form.disclosure} onChange={e => setForm({ ...form, disclosure: e.target.value })} /></label>
      <label className="block"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Enable requests for this inventory</label>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy}>Save policy</Button> <Button disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
    </form>}
  </Card>;
}
