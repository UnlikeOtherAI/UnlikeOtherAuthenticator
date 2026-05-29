import React, { useId, useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { PasswordInput } from '../ui/PasswordInput.js';
import { Switch } from '../ui/Switch.js';
import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';
import { isRegistrationAllowed } from '../../utils/auth-config.js';

type LoginRequest = {
  email: string;
  password: string;
  remember_me: boolean;
};

type LoginResponse = {
  twofa_required?: boolean;
  twofa_token?: string;
  redirect_to?: string;
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
    requestAccess,
    clientId,
    state,
    resource,
  } = usePopup();
  const registrationAllowed = isRegistrationAllowed(config);
  const { rememberMeEnabled, rememberMeDefault } = readSessionConfig(config);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(rememberMeDefault);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

    if (result.data.twofa_required && typeof result.data.twofa_token === 'string') {
      const twofaUrl = new URL(window.location.href);
      twofaUrl.searchParams.set('twofa_token', result.data.twofa_token);
      window.location.assign(twofaUrl.toString());
      return;
    }

    if (typeof result.data.redirect_to === 'string') {
      redirectTo(result.data.redirect_to);
      return;
    }

    setError(t('form.login.error'));
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
    </form>
  );
}
