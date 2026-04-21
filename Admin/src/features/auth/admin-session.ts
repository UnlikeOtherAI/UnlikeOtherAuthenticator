import {
  Fragment,
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { adminEnv } from '../../config/env';

const storageKey = 'uoa-admin-session';

type AdminUser = {
  id?: string;
  email: string;
  domain?: string;
  role?: 'superuser';
};

type StoredSession = {
  accessToken: string;
  expiresAt: number;
};

type AdminSessionContextValue = {
  adminUser: AdminUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  completeSignIn: (accessToken: string, expiresInSeconds: number) => Promise<AdminUser>;
  signOut: () => void;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

export function AdminSessionProvider({ children }: PropsWithChildren) {
  const [adminUser, setAdminUser] = useState<AdminUser | null>(() =>
    adminEnv.bypassAuth ? { email: 'admin@system.local', role: 'superuser' } : null,
  );
  const [isLoading, setIsLoading] = useState(() => !adminEnv.bypassAuth && Boolean(readStoredSession()));

  useEffect(() => {
    if (adminEnv.bypassAuth) return;

    const storedSession = readStoredSession();
    if (!storedSession) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void fetchAdminUser(storedSession.accessToken)
      .then((nextUser) => {
        if (cancelled) return;
        setAdminUser(nextUser);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        clearStoredSession();
        setAdminUser(null);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AdminSessionContextValue>(
    () => ({
      adminUser,
      isAuthenticated: Boolean(adminUser),
      isLoading,
      async completeSignIn(accessToken, expiresInSeconds) {
        writeStoredSession(accessToken, expiresInSeconds);
        const nextUser = await fetchAdminUser(accessToken);
        setAdminUser(nextUser);
        return nextUser;
      },
      signOut() {
        clearStoredSession();
        setAdminUser(null);
      },
    }),
    [adminUser, isLoading],
  );

  return createElement(AdminSessionContext.Provider, { value }, children);
}

export function useAdminSession(): Pick<AdminSessionContextValue, 'adminUser' | 'isLoading' | 'isAuthenticated'> {
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
  };
}

export function AdminSessionGuard({ children }: PropsWithChildren) {
  const location = useLocation();
  const session = useAdminSession();

  if (session.isLoading) {
    return null;
  }

  if (!session.isAuthenticated) {
    return createElement(Navigate, { to: '/login', replace: true, state: { from: location.pathname } });
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

function readStoredSession(): StoredSession | null {
  try {
    const storedValue = window.sessionStorage.getItem(storageKey);
    if (!storedValue) return null;

    const parsed = JSON.parse(storedValue) as StoredSession;
    if (!parsed.accessToken || parsed.expiresAt <= Date.now() + 5_000) {
      clearStoredSession();
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function clearStoredSession(): void {
  window.sessionStorage.removeItem(storageKey);
}

function writeStoredSession(accessToken: string, expiresInSeconds: number): void {
  const storedSession: StoredSession = {
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1_000,
  };
  window.sessionStorage.setItem(storageKey, JSON.stringify(storedSession));
}

function apiUrl(path: string): string {
  const baseUrl = adminEnv.apiBaseUrl || window.location.origin;
  return new URL(path, baseUrl).toString();
}

async function fetchAdminUser(accessToken: string): Promise<AdminUser> {
  const response = await fetch(apiUrl('/internal/admin/session'), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Admin session rejected.');
  }

  const body = (await response.json()) as { adminUser?: AdminUser };
  if (!body.adminUser?.email) {
    throw new Error('Admin session response was invalid.');
  }

  return body.adminUser;
}
