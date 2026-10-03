import { Link, useNavigate } from 'react-router';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { createApiClient, ApiRequestError } from '../../services/api-client';

export type LifecycleScope = 'USER' | 'ORGANISATION' | 'TEAM';
export type LifecycleTemplate = { id: string; scope: LifecycleScope; title: string; message: string; revision: number; enabled: boolean };
type Lifecycle = { status: 'ACTIVE' | 'DISABLED' | 'DELETING' | 'DELETED'; reason: string | null; internalNote: string | null; deletionJobId: string | null };
type Preview = { digest: string; confirmation: string; name: string; mode: string; deletesEmptyOrganisation: boolean;
  teamIds: string[]; candidates: { id: string; eligible: boolean; reasons: string[] }[];
  participants: { domain: string }[]; retainedEvidence: { model: string; count: number; reason: string }[]; blockers: string[] };
type Job = { id: string; status: string; preview: Preview; blockers: string[]; participants: { domain: string; acknowledgedAt: string | null; outcome: string | null; retainedEvidence?: {label:string;count:number;reason:string}[] }[] };
const api = createApiClient();
const inputClass = 'w-full rounded-lg border border-gray-300 p-2 text-sm';

export function EntityLifecyclePanel({ scope, id }: { scope: LifecycleScope; id: string }) {
  return <EntityLifecyclePanelBody key={`${scope}:${id}`} scope={scope} id={id} />;
}
function EntityLifecyclePanelBody({ scope, id }: { scope: LifecycleScope; id: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const path = `/internal/admin/lifecycle/${scope}/${encodeURIComponent(id)}`;
  const lifecycle = useQuery({ queryKey: ['admin', 'lifecycle', scope, id], queryFn: () => api.get<Lifecycle>(path) });
  const templates = useQuery({ queryKey: ['admin', 'lifecycle-templates'], queryFn: () => api.get<{ data: LifecycleTemplate[] }>('/internal/admin/lifecycle/templates') });
  const [templateId, setTemplateId] = useState(''), [note, setNote] = useState('');
  const [mode, setMode] = useState('RETAIN_REFERENCE'), [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const selected = templates.data?.data.find(t => t.id === templateId);
  async function act(task: () => Promise<unknown>) {
    setError(''); setPending(true);
    try { await task(); await queryClient.invalidateQueries({ queryKey: ['admin'] }); }
    catch (failure) { setError(failure instanceof ApiRequestError ? failure.code ?? failure.message : 'The action failed. Review the current state and try again.'); await lifecycle.refetch(); await templates.refetch(); }
    finally { setPending(false); }
  }
  if (!lifecycle.data) return <p role={lifecycle.isError ? 'alert' : undefined}> {lifecycle.isError ? 'Could not load lifecycle state.' : 'Loading lifecycle…'}</p>;
  const terminal = ['DELETING', 'DELETED'].includes(lifecycle.data.status);
  return <Card>
    <CardHeader><div><h2>Access and deletion</h2><p className="text-sm text-gray-600">{`Status: ${lifecycle.data.status.toLowerCase()}`}</p></div></CardHeader>
    <div className="space-y-4 p-5">
      {lifecycle.data.reason ? <p>Customer reason: {lifecycle.data.reason}</p> : null}
      {lifecycle.data.internalNote ? <p>Internal note: {lifecycle.data.internalNote}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {!terminal ? <>
        <label className="block">Reason template<select className={inputClass} value={templateId} onChange={e => setTemplateId(e.target.value)} disabled={pending}>
          <option value="">Choose a reason</option>{templates.data?.data.filter(t => t.enabled && t.scope === scope).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select></label>
        {selected ? <p className="text-sm">{selected.message}</p> : null}
        <label className="block">Internal note (administrators only)<textarea className={inputClass} value={note} maxLength={2000} onChange={e => setNote(e.target.value)} disabled={pending} /></label>
        <Button disabled={pending || (lifecycle.data.status === 'ACTIVE' && !selected)} onClick={() => void act(() => api.post(path, {
          status: lifecycle.data?.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE', templateId: selected?.id, templateRevision: selected?.revision, internalNote: note,
        }))}>{lifecycle.data.status === 'ACTIVE' ? 'Disable access' : 'Reactivate access'}</Button>
        <label className="block">Identity handling<select className={inputClass} value={mode} onChange={e => { setMode(e.target.value); setPreview(null); setConfirmation(''); }} disabled={pending}>
          <option value="RETAIN_REFERENCE">Retain a Deleted user reference</option><option value="ERASE_REFERENCE">Erase identity references</option>
        </select></label>
        <p className="text-sm text-gray-600">Deletion removes operational data and credentials. Retained history uses “Deleted user”. Protected financial or signing evidence may require restricted identity references.</p>
        <Button disabled={pending} onClick={() => void act(async () => { setPreview(await api.post<Preview>(`${path}/deletion-preview`, { mode })); setConfirmation(''); setRequestKey(crypto.randomUUID()); })}>Preview deletion</Button>
      </> : <p>This entity cannot sign in or regain access. Deletion is terminal.</p>}
      {preview && !terminal ? <div className="space-y-3 border-t pt-4">
        <p>Delete {preview.name} ({scope.toLowerCase()}) — {id}</p>
        <p>{preview.teamIds.length} teams in scope.{preview.deletesEmptyOrganisation ? ' The last team and its now-empty organisation will both be deleted.' : ''}</p>
        <ul>{preview.candidates.map(c => <li key={c.id}>{c.id}: {c.eligible ? 'account will be deleted' : `account kept — ${c.reasons.join(', ')}`}</li>)}</ul>
        <p>Products to acknowledge deletion: {preview.participants.map(p => p.domain).join(', ') || 'None identified'}</p>
        <ul>{preview.retainedEvidence.map((r, i) => <li key={i}>{r.model.replace(/([a-z])([A-Z])/g, '$1 $2')}: {r.count}. {r.reason}</li>)}</ul>
        {preview.blockers.length ? <ul role="alert">{preview.blockers.map(b => <li key={b}>{b}</li>)}</ul> : null}
        <label className="block">Type {preview.confirmation}<input className={inputClass} value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={pending} /></label>
        <Button variant="danger" disabled={pending || preview.blockers.length > 0 || confirmation !== preview.confirmation} onClick={() => void act(async () => {
          const created = await api.post<Job>(`${path}/delete`, { mode, previewDigest: preview.digest, confirmation, requestKey }); navigate(`/deletion-jobs/${encodeURIComponent(created.id)}`);
        })}>Confirm deletion</Button>
      </div> : null}
      {lifecycle.data.deletionJobId ? <Link className="text-indigo-600 hover:underline" to={`/deletion-jobs/${encodeURIComponent(lifecycle.data.deletionJobId)}`}>View deletion progress and retained evidence</Link> : null}
    </div>
  </Card>;
}
