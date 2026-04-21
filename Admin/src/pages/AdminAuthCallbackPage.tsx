import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import {
  clearPendingAdminLogin,
  exchangeAdminAuthorizationCode,
  readPendingAdminLogin,
} from '../features/auth/admin-oauth';
import { useAdminSession, useAdminSessionActions } from '../features/auth/admin-session';

export function AdminAuthCallbackPage() {
  const { isAuthenticated } = useAdminSession();
  const { completeSignIn, signOut } = useAdminSessionActions();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const hasStarted = useRef(false);

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard', { replace: true });
      return;
    }
    if (hasStarted.current) return;
    hasStarted.current = true;

    let cancelled = false;
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const pending = readPendingAdminLogin();

    if (!code || !pending || params.get('error')) {
      clearPendingAdminLogin();
      signOut();
      setError(true);
      return;
    }

    void exchangeAdminAuthorizationCode(code, pending)
      .then((token) => completeSignIn(token.access_token, token.expires_in))
      .then(() => {
        if (cancelled) return;
        clearPendingAdminLogin();
        navigate(pending.returnTo, { replace: true });
      })
      .catch(() => {
        if (cancelled) return;
        clearPendingAdminLogin();
        signOut();
        setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [completeSignIn, isAuthenticated, location.search, navigate, signOut]);

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-950 px-6 py-12 text-center">
      <p className="text-sm text-slate-400">
        {error ? 'Admin access was rejected. Superuser access is required.' : 'Completing admin sign-in.'}
      </p>
    </main>
  );
}
