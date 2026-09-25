import React, { useState, useEffect } from 'react';
import { NativeAppConsent } from '../components/form/NativeAppConsent.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { postJson } from '../utils/api.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';

type Result = { redirect_to?: string; twofa_required?: boolean; twofa_enroll_required?: boolean;
  setup_token?: string; manual_secret?: string };
export function NativeSocialPage(): React.JSX.Element {
  const { redirectTo, nativeFlowId } = usePopup();
  useEffect(() => {
    if (nativeFlowId) window.history.replaceState(null, '', `/oauth/social/complete?flow_id=${encodeURIComponent(nativeFlowId)}`);
  }, [nativeFlowId]);
  const { classNames } = useTheme();
  const [factor, setFactor] = useState<Result | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(false);
    const result = await postJson<{ flow_id: string; code?: string; setup_token?: string }, Result>('/oauth/social/complete',
      { flow_id: nativeFlowId ?? '', ...(factor ? { code: code || undefined, setup_token: factor.setup_token } : {}) });
    setBusy(false);
    if (!result.ok) { setError(true); return; }
    if (result.data.redirect_to) redirectTo(result.data.redirect_to);
    else setFactor(result.data);
  }
  return <form onSubmit={submit} className="flex flex-col gap-4">
    <h1 className={classNames.title}>{factor ? 'Authenticator code' : 'Complete sign-in'}</h1>
    <NativeAppConsent />
    {factor?.manual_secret ? <><p>Add this key to your authenticator, then enter its six-digit code.</p>
      <code className="break-all rounded border p-3">{factor.manual_secret}</code></> : null}
    {factor ? <Input label="Authenticator code" name="code" value={code} onChange={(e) => setCode(e.currentTarget.value)}
      inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /> : null}
    {error ? <p role="alert">Sign-in could not be completed. Try again or restart sign-in.</p> : null}
    <Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</Button>
  </form>;
}
