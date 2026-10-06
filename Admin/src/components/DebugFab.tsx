import { useState } from 'react';
import { issueAdminDebugLogin } from '../services/admin-debug-login-service';
import { Button } from './ui/Button';
import { DebugLoginButton } from './DebugLoginButton';
import { Modal } from './ui/Modal';

export function DebugFab() {
  const [isOpen, setIsOpen] = useState(false);
  const [grant, setGrant] = useState<{ url: string; token: string; expires_in: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  async function issue() {
    setPending(true); setError(''); setCopied(false);
    try { setGrant(await issueAdminDebugLogin(grant?.token)); }
    catch { setError('Unable to create a debug login. Sign in again or retry.'); }
    finally { setPending(false); }
  }
  const json = grant ? JSON.stringify({ url: grant.url, token: grant.token }, null, 2) : '';
  async function copy() {
    try { await navigator.clipboard.writeText(json); setCopied(true); }
    catch { setError('Unable to copy. Select and copy the code below.'); }
  }
  return <>
    <DebugLoginButton onClick={() => setIsOpen(true)} />
    <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Debug login" isPending={pending} widthClassName="max-w-xl"
      footer={<><Button variant="secondary" onClick={() => setIsOpen(false)} disabled={pending}>Close</Button>
        <Button variant="secondary" onClick={() => void issue()} disabled={pending}>{grant ? 'Renew' : 'Create code'}</Button>
        <Button variant="primary" onClick={() => void copy()} disabled={!grant || pending}>{copied ? 'Copied' : 'Copy'}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">Paste this one-use code into UOA Admin’s login screen to create an independent debug session.</p>
        <p className="text-xs text-gray-500">Valid for up to 30 minutes and while this source session remains active. Renew invalidates the previous code.</p>
        {grant ? <><p className="text-xs text-gray-500">Expires within {Math.ceil(grant.expires_in / 60)} minutes of creation.</p>
          <textarea readOnly value={json} aria-label="Debug login JSON" spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            className="h-40 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800" /></> : null}
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      </div>
    </Modal>
  </>;
}
