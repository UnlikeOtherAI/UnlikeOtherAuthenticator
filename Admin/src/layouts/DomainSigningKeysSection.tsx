import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { FieldShell, TextAreaField } from '../components/ui/FormFields';
import { useDomainJwksQuery } from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';
import { adminService } from '../services/admin-service';
import type { DomainJwk } from '../features/admin/types';

export function DomainSigningKeysSection({ domain }: { domain: string }) {
  const { data = [], isLoading } = useDomainJwksQuery(domain);
  const { confirm } = useAdminUi();
  const queryClient = useQueryClient();
  const [jwkText, setJwkText] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const parsed = useMemo(() => parseJwk(jwkText), [jwkText]);

  const addMutation = useMutation({
    mutationFn: (jwk: Record<string, unknown>) => adminService.addDomainJwk(domain, jwk),
    onSuccess: () => {
      setJwkText('');
      setAddError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'domain-jwks', domain] });
    },
    onError: (err) => setAddError(err instanceof Error ? err.message : 'Add failed'),
  });

  const deactivateMutation = useMutation({
    mutationFn: (kid: string) => adminService.deactivateDomainJwk(domain, kid),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'domain-jwks', domain] }),
  });

  function handleAdd() {
    if (!parsed.ok) {
      setAddError(parsed.error);
      return;
    }
    addMutation.mutate(parsed.jwk);
  }

  function handleDeactivate(row: DomainJwk) {
    confirm(
      `Deactivate JWK ${row.kid}?`,
      'The partner will no longer be able to sign config JWTs with this key. Active sessions keep working.',
      async () => {
        await deactivateMutation.mutateAsync(row.kid);
      },
    );
  }

  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Signing Keys</h3>
      {isLoading ? (
        <p className="text-sm text-gray-400">Loading signing keys...</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100">
          {data.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-400">No JWKs registered for this domain.</li>
          ) : (
            data.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-gray-700">{row.kid}</p>
                  <p className="truncate text-[11px] text-gray-400">{row.fingerprint}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={row.active ? 'green' : 'slate'}>{row.active ? 'active' : 'inactive'}</Badge>
                  {row.active ? (
                    <Button size="sm" variant="danger" onClick={() => handleDeactivate(row)}>
                      Deactivate
                    </Button>
                  ) : null}
                </div>
              </li>
            ))
          )}
        </ul>
      )}

      <FieldShell
        label="Add JWK (JSON)"
        hint={
          parsed.ok
            ? `Parsed: kid=${parsed.jwk.kid as string}`
            : 'Paste a single public JWK object with kty, kid, n, e.'
        }
        error={addError ?? undefined}
      >
        <TextAreaField
          className="font-mono"
          rows={5}
          placeholder='{"kty":"RSA","kid":"...","n":"...","e":"AQAB"}'
          value={jwkText}
          onChange={(event) => setJwkText(event.target.value)}
        />
      </FieldShell>
      <div className="flex justify-end">
        <Button
          icon="plus"
          variant="primary"
          disabled={!parsed.ok || addMutation.isPending}
          onClick={handleAdd}
        >
          Add signing key
        </Button>
      </div>
    </section>
  );
}

type ParseResult =
  | { ok: true; jwk: Record<string, unknown> }
  | { ok: false; error: string };

function parseJwk(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Paste a JWK JSON object.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'Invalid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected a JWK object.' };
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.kty !== 'RSA') return { ok: false, error: 'Only RSA keys are supported.' };
  if (typeof candidate.kid !== 'string' || !candidate.kid) return { ok: false, error: 'Missing "kid".' };
  if (typeof candidate.n !== 'string' || typeof candidate.e !== 'string') {
    return { ok: false, error: 'Missing "n" or "e".' };
  }
  return { ok: true, jwk: candidate };
}
