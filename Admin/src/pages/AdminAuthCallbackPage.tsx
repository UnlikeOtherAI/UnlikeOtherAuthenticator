import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import {
  clearPendingAdminLogin,
  exchangeAdminAuthorizationCode,
  readPendingAdminLogin,
} from '../features/auth/admin-oauth';
import { useAdminSessionActions } from '../features/auth/admin-session';

export function AdminAuthCallbackPage() {
  const { completeSignIn, clearFailedSignIn } = useAdminSessionActions();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const exchange = useRef<Promise<{ access_token: string; expires_in: number }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const pending = readPendingAdminLogin();

    if (!code || !pending || params.get('error')) {
      clearPendingAdminLogin();
      clearFailedSignIn();
      setError(true);
      return;
    }

    exchange.current ??= exchangeAdminAuthorizationCode(code, pending);
    void exchange.current
      .then((token) => {
        if (!cancelled) return completeSignIn(token.access_token, token.expires_in);
      })
      .then(() => {
        if (cancelled) return;
        clearPendingAdminLogin();
        navigate(pending.returnTo, { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
        clearPendingAdminLogin();
        clearFailedSignIn();
        setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [completeSignIn, location.search, navigate, clearFailedSignIn]);

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-950 px-6 py-12 text-center">
      <p className="text-sm text-slate-400">
        {error ? 'Admin sign-in failed. Please try again.' : 'Completing admin sign-in.'}
      </p>
    </main>
  );
}
