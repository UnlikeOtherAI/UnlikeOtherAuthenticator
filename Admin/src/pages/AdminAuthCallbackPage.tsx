import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import {
  clearPendingAdminLogin,
  exchangeAdminAuthorizationCode,
  readPendingAdminLogin,
} from '../features/auth/admin-oauth';
import { useAdminSession, useAdminSessionActions } from '../features/auth/admin-session';

export function AdminAuthCallbackPage() {
  const { isAuthenticated, isLoading } = useAdminSession();
  const { completeSignIn, clearFailedSignIn } = useAdminSessionActions();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const completion = useRef<Promise<string> | null>(null);

  useEffect(() => {
    if (!completion.current && isAuthenticated) {
      navigate('/dashboard', { replace: true });
      return;
    }
    if (!completion.current && isLoading) return;

    let cancelled = false;
    completion.current ??= (async () => {
      const params = new URLSearchParams(location.search);
      const code = params.get('code');
      const pending = readPendingAdminLogin();
      if (!code || !pending || params.get('error')) throw new Error('Invalid admin callback');
      const token = await exchangeAdminAuthorizationCode(code, pending);
      await completeSignIn(token.access_token, token.expires_in);
      return pending.returnTo;
    })();
    void completion.current
      .then((returnTo) => {
        if (cancelled) return;
        clearPendingAdminLogin();
        navigate(returnTo, { replace: true });
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
  }, [completeSignIn, location.search, navigate, clearFailedSignIn, isAuthenticated, isLoading]);

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-950 px-6 py-12 text-center">
      <p className="text-sm text-slate-400">
        {error ? 'Admin sign-in failed. Please try again.' : 'Completing admin sign-in.'}
      </p>
    </main>
  );
}
