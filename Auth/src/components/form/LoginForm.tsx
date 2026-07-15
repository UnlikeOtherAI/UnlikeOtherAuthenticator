import React, { useId, useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { PasswordInput } from '../ui/PasswordInput.js';
import { Switch } from '../ui/Switch.js';
import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';
import { isEmailCodeEnabled, isRegistrationAllowed } from '../../utils/auth-config.js';
import { requestSignInCode } from '../../utils/workspace-actions.js';
import { applyWorkspaceOutcome, interpretWorkspaceResponse } from '../../utils/workspace-response.js';

type LoginRequest = {
  email: string;
  password: string;
  remember_me: boolean;
};

type LoginResponse = {
  twofa_required?: boolean;
  twofa_token?: string;
  twofa_enroll_required?: boolean;
  setup_token?: string;
  otpauth_uri?: string;
  qr_svg?: string;
  manual_secret?: string;
  redirect_to?: string;
  // Workspace chooser payload (design §11.2, `workspace_selection: "auto"`); no `ok` field.
  login_token?: string;
  teams?: unknown[];
  pending_invites?: unknown[];
  can_create_org?: boolean;
};

function readSessionConfig(config: unknown): {
  rememberMeEnabled: boolean;
  rememberMeDefault: boolean;
} {
  if (config && typeof config === 'object' && 'session' in config) {
    const s = (config as Record<string, unknown>).session;
    if (s && typeof s === 'object') {
      const session = s as Record<string, unknown>;
      return {
        rememberMeEnabled: session.remember_me_enabled !== false,
        rememberMeDefault: session.remember_me_default !== false,
      };
    }
  }
  return { rememberMeEnabled: true, rememberMeDefault: true };
}

export function LoginForm(): React.JSX.Element {
  const rememberMeId = useId();
  const { t } = useTranslation();
  const {
    configUrl,
    config,
    redirectUrl,
    codeChallenge,
    codeChallengeMethod,
    redirectTo,
    setView,
    startTwoFactorVerify,
    startTwoFactorSetup,
    requestAccess,
    clientId,
    state,
    resource,
    scope,
    setPendingEmail,
    setLoginToken,
    setWorkspaceChoices,
  } = usePopup();
  const registrationAllowed = isRegistrationAllowed(config);
  const emailCodeEnabled = isEmailCodeEnabled(config);
  const { rememberMeEnabled, rememberMeDefault } = readSessionConfig(config);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(rememberMeDefault);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Public-client / MCP profile (brief §22.14): no config_url — post to the
    // secret-less /oauth/login keyed on the registered client_id + redirect_uri.
    const mcpMode = Boolean(clientId);
    const endpoint = mcpMode ? '/oauth/login' : '/auth/login';

    const query: Record<string, string | boolean | null> = mcpMode
      ? { client_id: clientId }
      : { config_url: configUrl };
    if (redirectUrl) query[mcpMode ? 'redirect_uri' : 'redirect_url'] = redirectUrl;
    if (codeChallenge && codeChallengeMethod) {
      query.code_challenge = codeChallenge;
      query.code_challenge_method = codeChallengeMethod;
    }
    if (mcpMode) {
      if (state) query.state = state;
      if (resource) query.resource = resource;
      if (scope) query.scope = scope;
    } else if (requestAccess) {
      query.request_access = true;
    }

    const result = await postJson<LoginRequest, LoginResponse>(
      endpoint,
      { email, password, remember_me: rememberMe },
      query,
    );

    setLoading(false);

    if (!result.ok) {
      setError(t('form.login.error'));
      return;
    }

    // Phase 3c (design §11.2): a password login can resolve to the same four shapes
    // /auth/verify-code and /auth/select-team do — including the workspace chooser when
    // `workspace_selection: "auto"`. Decode once, then apply generically.
    const outcome = interpretWorkspaceResponse(result.data);
    if (outcome.kind === 'chooser') {
      setPendingEmail(email);
    }
    const applied = applyWorkspaceOutcome(outcome, {
      setLoginToken,
      setWorkspaceChoices,
      setView,
      redirectTo,
      startTwoFactorVerify,
      startTwoFactorSetup,
    });
    if (!applied) setError(t('form.login.error'));
  }

  async function handleEmailCode() {
    if (!email) return;
    setSendingCode(true);
    await requestSignInCode({
      email,
      configUrl,
      redirectUrl,
      codeChallenge,
      codeChallengeMethod,
      requestAccess,
    });
    setSendingCode(false);
    setPendingEmail(email);
    setView('code-entry');
  }

  return (
    <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
      <Input
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        label={t('form.email.label')}
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
      />

      <PasswordInput
        name="password"
        autoComplete="current-password"
        required
        label={t('form.password.label')}
        showToggleLabel={t('form.password.show')}
        hideToggleLabel={t('form.password.hide')}
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
      />

      {rememberMeEnabled && (
        <Switch
          id={rememberMeId}
          checked={rememberMe}
          onChange={setRememberMe}
          label={t('form.rememberMe.label')}
        />
      )}

      {error && <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p>}

      <div className="mt-2">
        <Button variant="primary" type="submit" disabled={loading}>
          {loading ? '...' : t('form.login.submit')}
        </Button>
      </div>

      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-[var(--uoa-color-primary)] hover:underline"
          onClick={() => setView('reset-password')}
        >
          {t('nav.forgotPassword')}
        </button>
        {registrationAllowed ? (
          <button
            type="button"
            className="text-[var(--uoa-color-primary)] hover:underline"
            onClick={() => setView('register')}
          >
            {t('nav.createAccount')}
          </button>
        ) : null}
      </div>

      {emailCodeEnabled ? (
        <div className="text-center text-sm">
          <button
            type="button"
            className="text-[var(--uoa-color-primary)] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void handleEmailCode()}
            disabled={!email || sendingCode}
          >
            {t('nav.emailMeCode')}
          </button>
        </div>
      ) : null}
    </form>
  );
}
