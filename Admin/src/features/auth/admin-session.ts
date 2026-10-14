import { ApiRequestError, createApiClient } from '../../services/api-client';
import { logoutAdminSession } from '../../services/admin-debug-login-service';
import {
  Fragment,
  createContext,
  createElement,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { Navigate, useLocation } from 'react-router';

import { adminEnv } from '../../config/env';
import {
  clearStoredAdminSession,
  readStoredAdminSession,
  readStoredAdminSessionForLogout,
  writeStoredAdminSession,
} from './admin-session-storage';

type AdminUser = {
  id?: string;
  email: string;
  domain?: string;
  role?: 'superuser';
};

type AdminSessionContextValue = {
  adminUser: AdminUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  completeSignIn: (accessToken: string, expiresInSeconds: number) => Promise<AdminUser>;
  signOut: () => Promise<void>;
  clearFailedSignIn: () => void;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

export function AdminSessionProvider({ children }: PropsWithChildren) {
  const [adminUser, setAdminUser] = useState<AdminUser | null>(() =>
    adminEnv.bypassAuth ? { email: 'admin@system.local', role: 'superuser' } : null,
  );
  const [isLoading, setIsLoading] = useState(
    () => !adminEnv.bypassAuth && Boolean(readStoredAdminSession()),
  );

  useEffect(() => {
    if (adminEnv.bypassAuth) return;

    const storedSession = readStoredAdminSession();
    if (!storedSession) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 1000;
    const bootstrap = () => {
      const current = readStoredAdminSession();
      if (!current) {
        setAdminUser(null);
        setIsLoading(false);
        return;
      }
      void fetchAdminUser(current.accessToken)
        .then((nextUser) => {
          if (cancelled) return;
          if (readStoredAdminSession()?.accessToken !== current.accessToken) return;
          setAdminUser(nextUser);
          setIsLoading(false);
        })
        .catch((error: unknown) => {
          if (cancelled || readStoredAdminSession()?.accessToken !== current.accessToken) return;
          if (!(error instanceof ApiRequestError) || ![401, 403].includes(error.status)) {
            retry = setTimeout(bootstrap, delay);
            delay = Math.min(delay * 2, 30000);
            return;
          }
          clearStoredAdminSession();
          setAdminUser(null);
          setIsLoading(false);
        });
    };
    bootstrap();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    if (adminEnv.bypassAuth) return;
    const clear = () => {
      setAdminUser(null);
      setIsLoading(false);
    };
    const check = () => {
      if (!readStoredAdminSession()) clear();
    };
    const timer = setInterval(check, 1000);
    window.addEventListener('uoa-admin-session-cleared', clear);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('uoa-admin-session-cleared', clear);
      window.removeEventListener('focus', check);
    };
  }, []);

  const completeSignIn = useCallback(async (accessToken: string, expiresInSeconds: number) => {
    const nextUser = await fetchAdminUser(accessToken);
    writeStoredAdminSession(accessToken, expiresInSeconds);
    setAdminUser(nextUser);
    setIsLoading(false);
    return nextUser;
  }, []);
  const clearFailedSignIn = useCallback(() => {
    clearStoredAdminSession();
    setAdminUser(null);
  }, []);

  const value = useMemo<AdminSessionContextValue>(
    () => ({
      adminUser,
      isAuthenticated: Boolean(adminUser),
      isLoading,
      completeSignIn,
      clearFailedSignIn,
      async signOut() {
        const stored = readStoredAdminSessionForLogout();
        if (stored) {
          try {
            await logoutAdminSession(stored.accessToken);
          } catch (error) {
            if (!(error instanceof ApiRequestError) || ![401, 403].includes(error.status))
              throw error;
          }
        }
        clearStoredAdminSession();
        setAdminUser(null);
      },
    }),
    [adminUser, isLoading, completeSignIn, clearFailedSignIn],
  );

  return createElement(AdminSessionContext.Provider, { value }, children);
}

export function useAdminSession(): Pick<
  AdminSessionContextValue,
  'adminUser' | 'isLoading' | 'isAuthenticated'
> {
  const session = useRequiredAdminSessionContext();

  return {
    adminUser: session.adminUser,
    isLoading: session.isLoading,
    isAuthenticated: session.isAuthenticated,
  };
}

export function useAdminSessionActions() {
  const session = useRequiredAdminSessionContext();

  return {
    completeSignIn: session.completeSignIn,
    signOut: session.signOut,
    clearFailedSignIn: session.clearFailedSignIn,
  };
}

export function AdminSessionGuard({ children }: PropsWithChildren) {
  const location = useLocation();
  const session = useAdminSession();

  if (session.isLoading) {
    return createElement(
      'p',
      { role: 'status', className: 'p-6 text-sm text-gray-500' },
      'Connecting to UOA…',
    );
  }

  if (!session.isAuthenticated) {
    return createElement(Navigate, {
      to: '/login',
      replace: true,
      state: { from: location.pathname },
    });
  }

  return createElement(Fragment, null, children);
}

function useRequiredAdminSessionContext() {
  const session = useContext(AdminSessionContext);

  if (!session) {
    throw new Error('AdminSessionProvider is missing.');
  }

  return session;
}

const sessionApi = createApiClient();

async function fetchAdminUser(accessToken: string): Promise<AdminUser> {
  const body = await sessionApi.get<{ adminUser?: AdminUser }>('/internal/admin/session', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!body.adminUser?.email) throw new Error('Admin session response was invalid.');
  return body.adminUser;
}
