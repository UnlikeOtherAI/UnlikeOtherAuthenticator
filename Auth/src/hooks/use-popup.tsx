import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';

export type AuthView = 'login' | 'register' | 'reset-password' | 'set-password';

export type PopupQueryParams = {
  redirectUrl: string | null;
  twoFaToken: string | null;
  /** Token from an email link landing (registration verify or password reset). */
  emailToken: string | null;
  /** The type of email link flow, set by the server on landing routes. */
  emailTokenType: 'VERIFY_EMAIL_SET_PASSWORD' | 'VERIFY_EMAIL' | 'LOGIN_LINK' | 'PASSWORD_RESET' | null;
};

export type PopupContextValue = PopupQueryParams & {
  configUrl: string;
  /** The raw client config object (for reading enabled_auth_methods, etc.). */
  config: unknown;
  /** Current auth view. */
  view: AuthView;
  /** Navigate between auth views. */
  setView: (view: AuthView) => void;
  /**
   * Perform the final OAuth redirect (authorization code flow).
   * This intentionally uses a normal top-level navigation, not postMessage.
   */
  redirectTo: (url: string) => void;
};

const PopupContext = createContext<PopupContextValue | null>(null);

function normalizeSearch(value: string): string {
  if (!value) return '';
  return value.startsWith('?') ? value : `?${value}`;
}

export function parsePopupQueryParams(search: string): PopupQueryParams {
  const s = normalizeSearch(search);
  if (!s) return { redirectUrl: null, twoFaToken: null, emailToken: null, emailTokenType: null };

  const params = new URLSearchParams(s);

  const redirectUrl = params.get('redirect_url');
  const twoFaToken = params.get('twofa_token');
  const emailToken = params.get('email_token');
  const rawType = params.get('email_token_type');

  const validTypes = ['VERIFY_EMAIL_SET_PASSWORD', 'VERIFY_EMAIL', 'LOGIN_LINK', 'PASSWORD_RESET'] as const;
  const emailTokenType = rawType && (validTypes as readonly string[]).includes(rawType)
    ? (rawType as PopupQueryParams['emailTokenType'])
    : null;

  return {
    redirectUrl: redirectUrl && redirectUrl.trim() ? redirectUrl : null,
    twoFaToken: twoFaToken && twoFaToken.trim() ? twoFaToken : null,
    emailToken: emailToken && emailToken.trim() ? emailToken : null,
    emailTokenType,
  };
}

function readClientSearch(): string {
  if (typeof window === 'undefined') return '';
  return window.location?.search ?? '';
}

function deriveInitialView(parsed: PopupQueryParams): AuthView {
  if (parsed.emailToken && parsed.emailTokenType) {
    // Email link landing: show set-password for both registration+password and password reset.
    if (parsed.emailTokenType === 'VERIFY_EMAIL_SET_PASSWORD' || parsed.emailTokenType === 'PASSWORD_RESET') {
      return 'set-password';
    }
    // VERIFY_EMAIL and LOGIN_LINK are handled by auto-submission on the server; shouldn't reach here,
    // but default to login if they do.
  }
  return 'login';
}

export function PopupProvider(props: {
  configUrl: string;
  config?: unknown;
  initialSearch?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [search] = useState(() => {
    // Keep the initial value stable for SSR hydration.
    return props.initialSearch ?? readClientSearch();
  });

  const parsed = useMemo(() => parsePopupQueryParams(search), [search]);
  const [view, setViewState] = useState<AuthView>(() => deriveInitialView(parsed));

  const setView = useCallback((v: AuthView) => setViewState(v), []);

  const value = useMemo<PopupContextValue>(() => {
    return {
      configUrl: props.configUrl,
      config: props.config,
      redirectUrl: parsed.redirectUrl,
      twoFaToken: parsed.twoFaToken,
      emailToken: parsed.emailToken,
      emailTokenType: parsed.emailTokenType,
      view,
      setView,
      redirectTo: (url: string) => {
        if (typeof window === 'undefined') return;
        window.location.assign(url);
      },
    };
  }, [parsed.redirectUrl, parsed.twoFaToken, parsed.emailToken, parsed.emailTokenType, view, setView, props.configUrl, props.config]);

  return <PopupContext.Provider value={value}>{props.children}</PopupContext.Provider>;
}

export function usePopup(): PopupContextValue {
  const ctx = useContext(PopupContext);
  if (!ctx) throw new Error('usePopup must be used within <PopupProvider />');
  return ctx;
}
