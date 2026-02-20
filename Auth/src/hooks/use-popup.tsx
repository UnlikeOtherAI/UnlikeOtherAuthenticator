import React, { createContext, useContext, useMemo, useState } from 'react';

export type PopupQueryParams = {
  redirectUrl: string | null;
  twoFaToken: string | null;
};

export type PopupContextValue = PopupQueryParams & {
  configUrl: string;
  /** The raw client config object (for reading enabled_auth_methods, etc.). */
  config: unknown;
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
  if (!s) return { redirectUrl: null, twoFaToken: null };

  const params = new URLSearchParams(s);

  const redirectUrl = params.get('redirect_url');
  const twoFaToken = params.get('twofa_token');

  return {
    redirectUrl: redirectUrl && redirectUrl.trim() ? redirectUrl : null,
    twoFaToken: twoFaToken && twoFaToken.trim() ? twoFaToken : null,
  };
}

function readClientSearch(): string {
  if (typeof window === 'undefined') return '';
  return window.location?.search ?? '';
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

  const value = useMemo<PopupContextValue>(() => {
    return {
      configUrl: props.configUrl,
      config: props.config,
      redirectUrl: parsed.redirectUrl,
      twoFaToken: parsed.twoFaToken,
      redirectTo: (url: string) => {
        if (typeof window === 'undefined') return;
        window.location.assign(url);
      },
    };
  }, [parsed.redirectUrl, parsed.twoFaToken, props.configUrl, props.config]);

  return <PopupContext.Provider value={value}>{props.children}</PopupContext.Provider>;
}

export function usePopup(): PopupContextValue {
  const ctx = useContext(PopupContext);
  if (!ctx) throw new Error('usePopup must be used within <PopupProvider />');
  return ctx;
}
