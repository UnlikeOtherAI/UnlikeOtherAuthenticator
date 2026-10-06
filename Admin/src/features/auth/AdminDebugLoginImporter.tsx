import { DebugLoginButton } from '../../components/DebugLoginButton';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { redeemAdminDebugLogin } from '../../services/admin-debug-login-service';
import { useAdminSessionActions } from './admin-session';

export function AdminDebugLoginImporter() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const { completeSignIn } = useAdminSessionActions();
  async function redeem() {
    setPending(true); setError('');
    try {
      const pair = await redeemAdminDebugLogin(input);
      await completeSignIn(pair.access_token, pair.expires_in);
    } catch { setError('Unable to use this debug code. Check the destination and request a new code.'); }
    finally { setPending(false); }
  }
  return <>
    <DebugLoginButton onClick={() => setOpen(true)} />
    <Modal isOpen={open} onClose={() => { setOpen(false); setInput(''); setError(''); }} title="Debug login" isPending={pending}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
        <Button variant="primary" onClick={() => void redeem()} disabled={pending || !input.trim()}>Sign in</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">Paste the JSON or one-use code from an authenticated UOA administrator.</p>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} aria-label="Debug login code or JSON" spellCheck={false}
          className="h-40 w-full resize-none rounded-lg border border-gray-200 p-3 font-mono text-xs text-gray-800" />
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      </div>
    </Modal>
  </>;
}
