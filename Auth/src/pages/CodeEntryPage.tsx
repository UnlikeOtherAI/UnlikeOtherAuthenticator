import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { CodeInput } from '../components/ui/CodeInput.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';
import type { AuthFlowQuery } from '../utils/api.js';
import { requestSignInCode, submitVerifyCode } from '../utils/workspace-actions.js';
import { applyWorkspaceOutcome } from '../utils/workspace-response.js';

const CODE_LENGTH = 6;

/**
 * Phase 3c (design §11.2): "We sent a code to {email}" + the 6-digit `CodeInput`. On submit,
 * `/auth/verify-code` may resolve to the workspace chooser, a 2FA challenge, or a final redirect
 * — all decoded by the shared `applyWorkspaceOutcome` helper so this page only owns its own form
 * state. Failures are always generic; the user can retry or ask for a fresh code.
 */
export function CodeEntryPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const {
    pendingEmail,
    configUrl,
    redirectUrl,
    codeChallenge,
    codeChallengeMethod,
    requestAccess,
    setView,
    setLoginToken,
    setWorkspaceChoices,
    redirectTo,
    startTwoFactorVerify,
    startTwoFactorSetup,
  } = usePopup();

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  const query = useMemo<AuthFlowQuery>(
    () => ({ configUrl, redirectUrl, codeChallenge, codeChallengeMethod, requestAccess }),
    [configUrl, redirectUrl, codeChallenge, codeChallengeMethod, requestAccess],
  );

  // Not reachable directly (no email pending yet) — bounce back to login.
  useEffect(() => {
    if (!pendingEmail) setView('login');
  }, [pendingEmail, setView]);

  if (!pendingEmail) {
    return <div />;
  }
  const email = pendingEmail;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const outcome = await submitVerifyCode({ email, code, ...query });
    setSubmitting(false);

    const applied = applyWorkspaceOutcome(outcome, {
      setLoginToken,
      setWorkspaceChoices,
      setView,
      redirectTo,
      startTwoFactorVerify,
      startTwoFactorSetup,
    });
    if (!applied) setError(t('codeEntry.error'));
  }

  async function handleResend() {
    setResending(true);
    setResent(false);
    await requestSignInCode({ email, ...query });
    setResending(false);
    setResent(true);
  }

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.codeEntry.title')}</h1>
      <p className="mt-2 text-sm text-[var(--uoa-color-muted)]">
        {t('codeEntry.instructions', { email })}
      </p>

      <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
        <CodeInput
          value={code}
          onChange={setCode}
          length={CODE_LENGTH}
          disabled={submitting}
          autoFocus
          label={t('twoFactor.code.label')}
        />

        {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

        <div className="mt-2">
          <Button variant="primary" type="submit" disabled={submitting || code.length !== CODE_LENGTH}>
            {submitting ? '...' : t('codeEntry.submit')}
          </Button>
        </div>
      </form>

      <div className="mt-4 text-center text-sm">
        <button
          type="button"
          className="text-[var(--uoa-color-primary)] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void handleResend()}
          disabled={resending}
        >
          {t('codeEntry.resend')}
        </button>
        {resent ? (
          <p role="status" className="mt-2 text-sm text-[var(--uoa-color-muted)]">
            {t('codeEntry.resend.sent')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
