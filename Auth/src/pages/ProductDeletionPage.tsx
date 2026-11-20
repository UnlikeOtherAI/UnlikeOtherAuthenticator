import { useEffect, useState, type FormEvent } from 'react';
import { EnterpriseActionLayout } from '../components/layout/EnterpriseActionLayout.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';

const root = '/auth/delete-account';
type Container = { id: string; name: string; scope: 'TEAM' | 'ORGANISATION'; teamNames: string[]; retained: { reason: string; count: number }[] };
type Policy = { name: string; disclosure: string };
type Preview = { digest: string; impact: Policy & { mode: string; containers: Container[];
  contexts: { orgId: string; name: string; shared: boolean; teams: { teamId: string; name: string }[] }[] } };
async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(root + '/' + path, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(body) });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

export function ProductDeletionPage({ product, rejoin }: { product: string; rejoin: boolean }) {
  const [policy, setPolicy] = useState<Policy>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [challengeId, setChallenge] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [selection, setSelection] = useState('');
  const [receipt, setReceipt] = useState<{ receipt: string; complete: boolean }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const cancel = new AbortController();
    fetch(root + '/product/' + encodeURIComponent(product), { signal: cancel.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error(); setPolicy(await response.json() as Policy); })
      .catch(() => { if (!cancel.signal.aborted) setError('Account deletion for this product is unavailable.'); });
    return () => cancel.abort();
  }, [product]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!challengeId) {
        setChallenge((await post<{ challengeId: string }>('start', { product, email, rejoin })).challengeId);
      } else if (!preview) {
        setPreview(await post<Preview>('confirm', { product, rejoin, challengeId, code, ...(password && { password }), ...(twoFactorCode && { twoFactorCode }) }));
        setPassword('');
      } else {
        const target = preview.impact.containers.find(c => c.id === selection);
        setReceipt(await post('submit-product', { product, rejoin, challengeId, digest: preview.digest,
          ...(target && { container: { scope: target.scope, id: target.id } }) }));
      }
    } catch {
      setError(preview ? 'The deletion could not be confirmed. Request a fresh review before trying again.' :
        challengeId ? (rejoin ? 'Check your codes. Fresh registration opens after deletion finishes and at least 61 minutes after the request.' : 'Check your verification codes or request a fresh review.') : 'Could not send the code. Try again in a few minutes.');
    } finally { setBusy(false); }
  }
  const selected = preview?.impact.containers.find(c => c.id === selection);
  const displayedPolicy = preview?.impact ?? policy;
  const title = displayedPolicy ? (rejoin ? `Rejoin ${displayedPolicy.name}` : `Delete your ${displayedPolicy.name} account`) : 'Product account deletion';
  return <EnterpriseActionLayout title={title} showLanguageSelector={false}>
    {error && <p role="alert">{error}</p>}
    {receipt ? <div role="status"><h2>{rejoin ? 'You can sign in to a fresh product account' : receipt.complete ? 'Product account deletion complete' : 'Deletion in progress'}</h2>
      <p>Receipt {receipt.receipt}</p><a href={root + '/receipt/' + receipt.receipt}>Check deletion status</a></div> :
      policy ? <form className="space-y-4" onSubmit={event => void submit(event)}>
        <p>{rejoin ? 'Rejoin with a fresh account after deletion has finished and earlier access tokens have expired.' : displayedPolicy?.disclosure}</p><p>Your other products and your UnlikeOtherAI sign-in stay available.</p>
        {!challengeId ? <Input label="Account email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /> :
          preview ? <>
            <p>{rejoin ? 'Confirm fresh product registration. Deleted data stays erased.' : preview.impact.mode === 'ORGANISATION' && preview.impact.contexts.some(c => c.shared)
              ? 'Your personal data will be erased. Shared company records covered by the retention policy may remain with personal attribution removed.'
              : 'Your personal product data will be erased across your workspaces.'}</p>
            {preview.impact.contexts.length > 0 && <ul>{preview.impact.contexts.map(org => <li key={org.orgId}>
              {org.name}{org.teams.length > 0 && ' — ' + org.teams.map(team => team.name).join(', ')}
            </li>)}</ul>}
            {preview.impact.containers.length > 0 && <label className="block">What should be deleted?
              <select className="block w-full" value={selection} onChange={e => setSelection(e.target.value)}>
                <option value="">My product account only</option>
                {preview.impact.containers.map(c => <option key={c.id} value={c.id}>Also request permanent deletion of {c.scope.toLowerCase()} {c.name}</option>)}
              </select><span className="block text-sm">An administrator reviews requests to delete a team or organisation.</span></label>}
            {selected?.scope === 'ORGANISATION' && selected.teamNames.length > 0 && <p>Included teams: {selected.teamNames.join(', ')}</p>}
            {selected && selected.retained.length > 0 && <ul>{selected.retained.map((r,i) =>
              <li key={i}>{r.reason} ({r.count})</li>)}</ul>}
          </> : <>
            <Input label="Email verification code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" required value={code} onChange={e => setCode(e.target.value)} />
            <Input label="Authenticator code, if enabled" inputMode="numeric" pattern="[0-9]{6}" value={twoFactorCode} onChange={e => setTwoFactorCode(e.target.value)} />
            <details><summary>Managed account without an authenticator</summary>
              <Input label="Personal UOA password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
            </details>
          </>}
        <Button type="submit" disabled={busy}>{preview ? (rejoin ? 'Confirm fresh registration' : 'Confirm permanent deletion') : challengeId ? (rejoin ? 'Review fresh registration' : 'Review deletion') : 'Send verification code'}</Button>
        {challengeId && <Button type="button" variant="secondary" disabled={busy} onClick={() => {
          setChallenge(''); setPassword(''); setPreview(undefined); setSelection(''); setCode(''); setTwoFactorCode(''); setError('');
        }}>Request a fresh review</Button>}
      </form> : !error && <p role="status">Loading product…</p>}
    {policy && <a className="underline" href={root}>Delete my UnlikeOtherAI account everywhere</a>}
  </EnterpriseActionLayout>;
}
