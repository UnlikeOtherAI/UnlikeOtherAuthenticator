import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { Button } from '../components/ui/Button';
import { adminAssets } from '../config/assets';
import { beginAdminSystemSignIn } from '../features/auth/admin-oauth';
import { useAdminSession } from '../features/auth/admin-session';

export function LoginPage() {
  const { isAuthenticated } = useAdminSession();
  const location = useLocation();
  const [error, setError] = useState(false);
  const hasStarted = useRef(false);
  const from =
    typeof location.state === 'object' && location.state && 'from' in location.state
      ? String(location.state.from)
      : '/dashboard';

  useEffect(() => {
    if (isAuthenticated) return;
    if (hasStarted.current) return;
    hasStarted.current = true;

    let cancelled = false;
    void beginAdminSystemSignIn(from).catch(() => {
      if (!cancelled) setError(true);
    });

    return () => {
      cancelled = true;
    };
  }, [from, isAuthenticated]);

  if (isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  return (
    <main className="flex min-h-full flex-col justify-center bg-slate-950 px-6 py-12">
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 text-center">
        <img src={adminAssets.appIcon} width="140" height="140" className="h-32 w-32 rounded-[20px]" alt="UOA" />
        <h1 className="text-2xl font-semibold tracking-tight text-white">UOA Admin</h1>
        <p className="text-sm text-slate-400">
          {error ? 'Unable to start system sign-in.' : 'Redirecting to system sign-in.'}
        </p>
        {error ? (
          <Button className="mt-4 border-indigo-600 bg-indigo-600 focus:ring-offset-slate-950" icon="logout" onClick={() => void beginAdminSystemSignIn(from)} variant="primary">
            Try again
          </Button>
        ) : null}
      </div>
    </main>
  );
}
