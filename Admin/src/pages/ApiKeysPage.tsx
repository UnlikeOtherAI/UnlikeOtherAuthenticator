import { useEffect, useState } from 'react';

import { Badge, type BadgeVariant } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FieldShell, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import {
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useRevokeApiKeyMutation,
} from '../features/admin/admin-queries';
import type { ApiKeyCreatedResponse, ApiKeyResponse } from '../services/admin-service';

type KeyStatus = { label: string; variant: BadgeVariant };

function keyStatus(key: ApiKeyResponse): KeyStatus {
  if (key.revoked_at) return { label: 'Revoked', variant: 'red' };
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    return { label: 'Expired', variant: 'slate' };
  }
  return { label: 'Active', variant: 'green' };
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

export function ApiKeysPage() {
  const { data: keys = [], isLoading } = useApiKeysQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreatedResponse | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyResponse | null>(null);

  const revoke = useRevokeApiKeyMutation();
  const { pageItems, pagination } = usePagination(keys);

  return (
    <>
      <PageHeader
        title="API Keys"
        description="Admin API keys for terminal/CI control of feature flags and kill switches."
        actions={<Button icon="plus" variant="primary" onClick={() => setCreateOpen(true)}>Create API key</Button>}
      />
      <Card>
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading API keys...</p>
        ) : (
          <>
            <DataTable headers={['Name', 'Key prefix', 'Last used', 'Expires', 'Status', 'Created by', 'Action']}>
              {pageItems.map((key) => {
                const status = keyStatus(key);
                const revoked = Boolean(key.revoked_at);
                return (
                  <tr key={key.id}>
                    <Td><p className="font-medium text-gray-700">{key.name}</p></Td>
                    <Td><code className="text-xs">{key.key_prefix}</code></Td>
                    <Td className="text-xs text-gray-400">{formatDate(key.last_used_at)}</Td>
                    <Td className="text-xs text-gray-400">{formatDate(key.expires_at)}</Td>
                    <Td><Badge variant={status.variant}>{status.label}</Badge></Td>
                    <Td className="text-xs text-gray-400">{key.created_by_email ?? '—'}</Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={revoked}
                        onClick={() => setPendingRevoke(key)}
                      >
                        Revoke
                      </Button>
                    </Td>
                  </tr>
                );
              })}
              {keys.length === 0 ? (
                <tr><Td colSpan={7} className="text-sm text-gray-400">No API keys yet.</Td></tr>
              ) : null}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>

      <CreateApiKeyModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false);
          setCreatedKey(created);
        }}
      />

      <ApiKeyRevealModal createdKey={createdKey} onClose={() => setCreatedKey(null)} />

      <Modal
        isOpen={Boolean(pendingRevoke)}
        onClose={() => setPendingRevoke(null)}
        title="Revoke API key?"
        widthClassName="max-w-sm"
        footer={(
          <>
            <Button onClick={() => setPendingRevoke(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={!pendingRevoke || revoke.isPending}
              onClick={() => {
                if (!pendingRevoke) return;
                revoke.mutate(pendingRevoke.id, { onSuccess: () => setPendingRevoke(null) });
              }}
            >
              Revoke key
            </Button>
          </>
        )}
      >
        <p className="text-sm text-gray-500">
          Revoking <span className="font-semibold">{pendingRevoke?.name}</span> immediately blocks any terminal or CI
          job using it. This cannot be undone.
        </p>
      </Modal>
    </>
  );
}

function CreateApiKeyModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (created: ApiKeyCreatedResponse) => void;
}) {
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateApiKeyMutation();

  useEffect(() => {
    if (isOpen) {
      setName('');
      setExpiresAt('');
      setError(null);
    }
  }, [isOpen]);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    // The API expects a full ISO-8601 datetime; a date input gives YYYY-MM-DD,
    // so expire at the end of that day in the operator's local timezone.
    const expiry = expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null;
    create.mutate(
      { name: trimmed, expiresAt: expiry },
      {
        onSuccess: onCreated,
        onError: (err) => setError(err instanceof Error ? err.message : 'Create failed'),
      },
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create API key"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="plus" variant="primary" disabled={create.isPending} onClick={submit}>
            Create key
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <FieldShell label="Name" hint="A label so you can recognise this key later (e.g. “CI deploy bot”)." error={error ?? undefined}>
          <TextField value={name} onChange={(event) => setName(event.target.value)} placeholder="CI deploy bot" />
        </FieldShell>
        <FieldShell label="Expiry (optional)" hint="Leave empty for a key that never expires.">
          <TextField type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </FieldShell>
      </div>
    </Modal>
  );
}

function ApiKeyRevealModal({
  createdKey,
  onClose,
}: {
  createdKey: ApiKeyCreatedResponse | null;
  onClose: () => void;
}) {
  const origin = window.location.origin;
  const key = createdKey?.key ?? '';

  const snippets: Array<{ label: string; command: string }> = [
    {
      label: 'List apps (find ids)',
      command: `curl -sS -H "X-API-Key: ${key}" \\\n  ${origin}/internal/admin/apps`,
    },
    {
      label: 'Create a feature flag',
      command: `curl -sS -X POST -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\\n  -d '{"key":"new_feature","default_state":false}' \\\n  ${origin}/internal/admin/apps/APP_ID/flags`,
    },
    {
      label: 'Flip a kill switch (toggle active)',
      command: `curl -sS -X PATCH -H "X-API-Key: ${key}" -H "Content-Type: application/json" \\\n  -d '{"platform":"ios","type":"hard","version_field":"versionName","operator":"lt","version_value":"1.0.0","version_scheme":"semver","active":true,"priority":0}' \\\n  ${origin}/internal/admin/apps/APP_ID/kill-switches/KILL_SWITCH_ID`,
    },
  ];

  return (
    <Modal
      isOpen={createdKey !== null}
      onClose={onClose}
      title="API key created"
      widthClassName="max-w-2xl"
      footer={(
        <Button variant="primary" onClick={onClose}>
          I have copied my key
        </Button>
      )}
    >
      {createdKey ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Copy this key now — it is shown <span className="font-semibold">only once</span> and cannot be retrieved
            again. If you lose it, revoke it and create a new one.
          </div>
          <CopyBlock label="API key" value={createdKey.key} sensitive />
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Terminal recipes
            </p>
            <p className="mb-3 text-xs text-gray-400">
              Authenticate with the <code>X-API-Key</code> header. Replace <code>APP_ID</code> /{' '}
              <code>KILL_SWITCH_ID</code> with ids from the apps list.
            </p>
            <div className="space-y-3">
              {snippets.map((snippet) => (
                <CopyBlock key={snippet.label} label={snippet.label} value={snippet.command} />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function CopyBlock({ label, value, sensitive }: { label: string; value: string; sensitive?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
        <Button icon="copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <pre
        className={
          sensitive
            ? 'overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-gray-900'
            : 'overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-gray-700'
        }
      >
        {value}
      </pre>
    </div>
  );
}
