/** Local-only browser fixture. Never imported by the application or CI. */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreateApiKeyMutation } from '../src/features/admin/admin-queries';
import { useCreateBillingAppKeyMutation } from '../src/features/admin/billing-admin-queries';
import {
  AdminSessionProvider,
  useAdminSession,
  useAdminSessionActions,
} from '../src/features/auth/admin-session';
import { clearStoredAdminSession } from '../src/features/auth/admin-session-storage';
import '../src/index.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const kind = new URLSearchParams(location.search).get('kind');
Object.assign(window, {
  auditCache: () =>
    JSON.stringify({
      mutations: client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
      queries: client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    }),
});

function Issuer({ open, reveal }: { open: boolean; reveal: (value: string) => void }) {
  const automation = useCreateApiKeyMutation((key) => reveal(key.key), open);
  const product = useCreateBillingAppKeyMutation('billing-1', (key) => reveal(key.key), open);
  const create = kind === 'automation' ? automation : product;
  return (
    <button
      onClick={() =>
        create.mutate({
          name: 'Lifecycle fixture',
          purpose: 'entitlement',
          actorIssuer: 'https://product.example',
          actorAudience: `${location.origin}/billing/v1/effective-tariff`,
          actorPublicJwkJson: '{}',
          checkoutReturnOrigins: '',
          expiresAt: '',
        })
      }
    >
      Issue fixture key
    </button>
  );
}

function Keys() {
  const [mounted, setMounted] = useState(true);
  const [open, setOpen] = useState(true);
  const [secret, setSecret] = useState('');
  return (
    <>
      <p>Test-only external lifecycle controls; production pending dialogs block dismissal.</p>
      <button
        onClick={() => {
          setOpen(false);
          setSecret('');
        }}
      >
        Close owner
      </button>
      <button onClick={() => setOpen(true)}>Reopen owner</button>
      <button
        onClick={() => {
          setMounted(false);
          setSecret('');
        }}
      >
        Unmount owner
      </button>
      <button
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        Mount owner
      </button>
      <button
        onClick={() => {
          clearStoredAdminSession();
          setSecret('');
        }}
      >
        Clear session
      </button>
      {mounted ? <Issuer open={open} reveal={setSecret} /> : <p>Owner unmounted</p>}
      <p role="status">{secret || 'No secret revealed'}</p>
    </>
  );
}

function Session() {
  const { completeSignIn } = useAdminSessionActions();
  const { isAuthenticated } = useAdminSession();
  const started = useRef(false);
  const [error, setError] = useState(false);
  const login = () => {
    setError(false);
    void completeSignIn('fixture-login', 1800).catch(() => setError(true));
  };
  useEffect(() => {
    if (kind !== 'strict' || started.current) return;
    started.current = true;
    void completeSignIn('fixture-login', 1800).catch(() => setError(true));
  }, [completeSignIn]);
  return (
    <>
      <button onClick={login}>Validate login</button>
      <button onClick={clearStoredAdminSession}>Clear session</button>
      <p role="status">{isAuthenticated ? 'Authenticated' : 'Signed out'}</p>
      {error ? <p>Superseded validation rejected</p> : null}
    </>
  );
}

const root = document.getElementById('fixture');
if (!root) throw new Error('Missing local fixture root');
createRoot(root).render(
  <StrictMode>
    <main className="mx-auto max-w-xl space-y-4 p-6 [&_button]:m-2 [&_button]:rounded [&_button]:border [&_button]:p-2">
      <h1>Local lifecycle regression fixture</h1>
      <QueryClientProvider client={client}>
        {kind === 'session' || kind === 'strict' ? (
          <AdminSessionProvider>
            <Session />
          </AdminSessionProvider>
        ) : (
          <Keys />
        )}
      </QueryClientProvider>
    </main>
  </StrictMode>,
);
