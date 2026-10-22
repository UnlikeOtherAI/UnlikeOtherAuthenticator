import React, { useMemo, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { RegistrationCodeInput } from '../components/ui/RegistrationCodeInput.js';
import { usePopup } from '../hooks/use-popup.js';
import { useRegistrationStatus, type RegistrationState } from '../hooks/use-registration-status.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';
import { postJson } from '../utils/api.js';
import { applyTeamOutcome, interpretTeamResponse } from '../utils/team-response.js';

export function RegistrationVerificationPage(): React.JSX.Element {
  const popup = usePopup();
  const { pendingRegistration: pending, configUrl, redirectUrl, codeChallenge, codeChallengeMethod, state, requestAccess } = popup;
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState<RegistrationState['status']>('pending');
  const busy = useRef(false);
  const finishing = useRef(false);
  const query = useMemo(() => ({
    config_url: configUrl, redirect_url: redirectUrl, code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod, state, request_access: requestAccess ? 'true' : undefined,
  }), [configUrl, redirectUrl, codeChallenge, codeChallengeMethod, state, requestAccess]);

  async function receive(next: RegistrationState) {
    setStatus(next.status);
    if (next.status !== 'authorized' || !next.token || finishing.current) return;
    finishing.current = true;
    if (next.token_type === 'VERIFY_EMAIL_SET_PASSWORD') {
      popup.setRegistrationProof(next.token, next.token_type);
      return;
    }
    setLoading(true);
    const result = await postJson('/auth/verify-email', { token: next.token }, query);
    if (result.ok && applyTeamOutcome(interpretTeamResponse(result.data), popup)) {
      popup.beginRegistration(null);
    } else {
      finishing.current = false;
      setLoading(false); setError(true);
    }
  }

  useRegistrationStatus({ id: pending?.id, query, onState: next => { void receive(next); } });

  async function submit(value: string) {
    if (!pending || busy.current || finishing.current || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(value)) return;
    busy.current = true;
    setLoading(true); setError(false);
    const result = await postJson<{ id: string; code: string }, RegistrationState>('/auth/registration/code', { id: pending.id, code: value }, query);
    busy.current = false;
    if (result.ok) await receive(result.data);
    else setError(true);
    if (!finishing.current) setLoading(false);
  }

  if (!pending) return <div />;
  const unavailable = status === 'expired' || status === 'complete';
  const [beforeEmail, afterEmail] = t('registration.sent', { email: '{email}' }).split('{email}');
  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('registration.checkEmail')}</h1>
      <p className="mt-3 text-sm text-[var(--uoa-color-text)]">{beforeEmail}<strong>{pending.email}</strong>{afterEmail}</p>
      <p className="mt-2 text-sm text-[var(--uoa-color-muted)]">{t('registration.instructions')}</p>
      {status === 'verified' ? <p role="status" className="mt-4 text-sm text-[var(--uoa-color-text)]">{t('registration.verifiedElsewhere')}</p> : null}
      {unavailable ? (
        <p role="status" className="mt-4 text-sm text-[var(--uoa-color-text)]">{t('registration.expired')}</p>
      ) : (
        <form className="mt-6 flex flex-col gap-4" aria-busy={loading} onSubmit={event => { event.preventDefault(); void submit(code); }}>
          <RegistrationCodeInput value={code} onChange={value => { setCode(value); setError(false); }}
            onComplete={value => { void submit(value); }} disabled={loading} label={t('registration.code')}
            errorId={error ? 'registration-error' : undefined} />
          {error ? <p id="registration-error" role="alert" className="text-sm text-[var(--uoa-color-danger)]">{t('registration.error')}</p> : null}
          {loading ? <p role="status" className="text-sm text-[var(--uoa-color-muted)]">{t('registration.verifying')}</p> : null}
          {error ? <Button type="submit" disabled={loading}>{t('codeEntry.submit')}</Button> : null}
        </form>
      )}
      <button type="button" className="mt-6 text-sm text-[var(--uoa-color-primary)] hover:underline"
        onClick={() => { popup.beginRegistration(null); popup.setView('register'); }}>
        {t('registration.restart')}
      </button>
    </div>
  );
}
