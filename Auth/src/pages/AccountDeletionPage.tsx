import { useState, type FormEvent } from 'react';
import { EnterpriseActionLayout } from '../components/layout/EnterpriseActionLayout.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';

const root = '/auth/delete-account';

async function request(step: 'start' | 'confirm', body: Record<string, string>) {
  const response = await fetch(`${root}/${step}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Account deletion request failed');
  return response.json() as Promise<{ challengeId?: string; submitted?: boolean }>;
}

export function AccountDeletionPage() {
  const [email, setEmail] = useState('');
  const [challengeId, setChallengeId] = useState<string>();
  const [code, setCode] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!challengeId) {
        const started = await request('start', { email });
        if (typeof started.challengeId !== 'string') throw new Error('Missing challenge');
        setChallengeId(started.challengeId);
        return;
      }
      const result = await request('confirm', { challengeId, code, ...(twoFactorCode && { twoFactorCode }) });
      if (result.submitted !== true) throw new Error('Unconfirmed request');
      setSubmitted(true);
    } catch {
      setError(challengeId
        ? 'Check your verification codes or request a new email code.'
        : 'Could not send a verification code. Try again in a few minutes.');
    } finally {
      setBusy(false);
    }
  }

  function startAgain() {
    setChallengeId(undefined);
    setCode('');
    setTwoFactorCode('');
    setError('');
  }

  return (
    <EnterpriseActionLayout title="Delete your UnlikeOtherAI account" showLanguageSelector={false}>
      {submitted ? (
        <div role="status" className="space-y-2">
          <h2 className="text-lg font-semibold">Deletion request received</h2>
          <p>We’ll review the request and contact you at your account email if we need anything else.</p>
        </div>
      ) : (
        <>
          <p>This request covers your UnlikeOtherAI account, including its use in Kelpie Browser and other connected products. Some records may be kept where required by law.</p>
          <form className="space-y-4" onSubmit={event => void submit(event)}>
            {challengeId ? (
              <>
                <p>Check your email for a six-digit code. If your account uses an authenticator, enter its current code too.</p>
                <Input label="Email verification code" autoComplete="one-time-code" inputMode="numeric"
                  value={code} onChange={event => setCode(event.target.value)} pattern="[0-9]{6}"
                  maxLength={6} required disabled={busy} />
                <Input label="Authenticator code, if enabled" inputMode="numeric" value={twoFactorCode}
                  onChange={event => setTwoFactorCode(event.target.value)} pattern="[0-9]{6}"
                  maxLength={6} disabled={busy} />
              </>
            ) : (
              <Input label="Account email" type="email" autoComplete="email" value={email}
                onChange={event => setEmail(event.target.value)} maxLength={320} required disabled={busy} />
            )}
            {error && <p role="alert" className="text-[var(--uoa-color-danger)]">{error}</p>}
            <Button type="submit" disabled={busy}>{challengeId ? 'Request account deletion' : 'Send verification code'}</Button>
            {challengeId && <Button type="button" variant="secondary" disabled={busy} onClick={startAgain}>Use a different email or get a new code</Button>}
          </form>
        </>
      )}
      <a className="text-sm underline" href="https://unlikeotherai.com/privacy/">UnlikeOtherAI privacy policy</a>
    </EnterpriseActionLayout>
  );
}
