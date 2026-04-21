import { useMemo, useState, type ReactNode } from 'react';

import { AutocompleteSelect } from '../components/ui/AutocompleteSelect';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../components/ui/FormFields';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import { useHandshakeErrorsQuery } from '../features/admin/admin-queries';
import type { HandshakeErrorLog } from '../features/admin/types';

export function ConnectionErrorsPage() {
  const { data: errors = [], isLoading } = useHandshakeErrorsQuery();
  const [selectedErrorId, setSelectedErrorId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('all');
  const [phase, setPhase] = useState('all');
  const domainOptions = useMemo(() => {
    const counts = new Map<string, number>();
    errors.forEach((error) => counts.set(error.domain, (counts.get(error.domain) ?? 0) + 1));

    return Array.from(counts.entries()).map(([item, count]) => ({ label: item, value: item, meta: `${count} errors` }));
  }, [errors]);
  const filteredErrors = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    return errors.filter((error) => {
      const matchesQuery = !normalized || [error.app, error.domain, error.errorCode, error.summary, error.requestId].some((value) => value.toLowerCase().includes(normalized));
      const matchesDomain = domain === 'all' || error.domain === domain;
      const matchesPhase = phase === 'all' || error.phase === phase;

      return matchesQuery && matchesDomain && matchesPhase;
    });
  }, [domain, errors, phase, query]);
  const { pageItems, pagination } = usePagination(filteredErrors);
  const selectedError = errors.find((error) => error.id === selectedErrorId) ?? filteredErrors[0] ?? null;

  function exportFilteredErrors() {
    const blob = new Blob([JSON.stringify(filteredErrors, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'connection-errors.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader title="Connection Errors" description="Rejected app handshakes, config JWT failures, and SDK startup errors" actions={<Button icon="download" onClick={exportFilteredErrors}>Export JSON</Button>} />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <FieldShell label="Search">
            <TextField className="w-72" placeholder="Error, request id, app, domain..." type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </FieldShell>
          <AutocompleteSelect allLabel="All domains" emptyLabel="No domains found." label="Domain" options={domainOptions} placeholder="Search domains..." value={domain} onChange={setDomain} />
          <FieldShell label="Phase">
            <SelectField value={phase} onChange={(event) => setPhase(event.target.value)}>
              <option value="all">All phases</option>
              <option value="config_fetch">Config fetch</option>
              <option value="config_domain">Config domain</option>
              <option value="jwt_verify">JWT verify</option>
              <option value="startup">Startup</option>
              <option value="token_exchange">Token exchange</option>
            </SelectField>
          </FieldShell>
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]">
        <Card>
          {isLoading ? (
            <p className="px-5 py-6 text-sm text-gray-400">Loading connection errors...</p>
          ) : (
            <>
              <DataTable headers={['Time', 'Domain', 'App', 'Phase', 'Error', 'Missing', 'Status']}>
                {pageItems.map((error) => (
                  <tr
                    key={error.id}
                    className="cursor-pointer transition-colors hover:bg-gray-50"
                    tabIndex={0}
                    onClick={() => setSelectedErrorId(error.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        setSelectedErrorId(error.id);
                      }
                    }}
                  >
                    <Td className="whitespace-nowrap text-xs text-gray-400">{error.ts}</Td>
                    <Td>
                      <span className="font-medium text-gray-900">{error.domain}</span>
                      <p className="mt-0.5 text-xs text-gray-400">{error.endpoint}</p>
                    </Td>
                    <Td>
                      <span className="font-medium text-gray-700">{error.app}</span>
                      <p className="mt-0.5 text-xs text-gray-400">{error.organisation}</p>
                    </Td>
                    <Td><Badge variant="blue">{phaseLabel(error.phase)}</Badge></Td>
                    <Td>
                      <code className="text-xs font-semibold text-red-600">{error.errorCode}</code>
                      <p className="mt-0.5 text-xs text-gray-400">{error.summary}</p>
                    </Td>
                    <Td className="text-xs text-gray-500">{error.missingClaims.length > 0 ? error.missingClaims.join(', ') : '-'}</Td>
                    <Td><Badge variant={error.statusCode >= 500 ? 'red' : 'amber'}>{error.statusCode}</Badge></Td>
                  </tr>
                ))}
                {pageItems.length === 0 ? (
                  <tr>
                    <Td colSpan={7} className="text-sm text-gray-400">No connection errors match the filters.</Td>
                  </tr>
                ) : null}
              </DataTable>
              <PaginationFooter {...pagination} />
            </>
          )}
        </Card>
        <ErrorDetail error={selectedError} />
      </div>
    </>
  );
}

function ErrorDetail({ error }: { error: HandshakeErrorLog | null }) {
  if (!error) {
    return (
      <Card className="p-5">
        <p className="text-sm text-gray-400">Select an error to inspect the sanitized request payload.</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <span className="text-sm font-semibold text-gray-900">Error Detail</span>
          <p className="mt-0.5 text-xs text-gray-400">{error.requestId}</p>
        </div>
        <Badge variant="red">{error.errorCode}</Badge>
      </CardHeader>
      <div className="space-y-4 p-5">
        <DetailGrid error={error} />
        <DetailSection title="Rejected because">
          <ul className="space-y-2">
            {error.details.map((detail) => <li key={detail} className="text-sm text-gray-600">{detail}</li>)}
          </ul>
        </DetailSection>
        <DetailSection title="Missing claims">
          {error.missingClaims.length > 0 ? <TokenList values={error.missingClaims} variant="amber" /> : <p className="text-sm text-gray-400">No required claims were missing.</p>}
        </DetailSection>
        <DetailSection title="Redactions applied">
          <TokenList values={error.redactions} variant="slate" />
        </DetailSection>
        <DetailSection title="JWT header">
          <JsonBlock value={error.jwtHeader} />
        </DetailSection>
        <DetailSection title="Sanitized JWT payload">
          <JsonBlock value={error.jwtPayload} />
        </DetailSection>
      </div>
    </Card>
  );
}

function DetailGrid({ error }: { error: HandshakeErrorLog }) {
  const rows = [
    ['Domain', error.domain],
    ['App', error.app],
    ['Endpoint', error.endpoint],
    ['Phase', phaseLabel(error.phase)],
    ['IP', error.ip],
    ['User agent', error.userAgent],
  ];

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
          <p className="mt-1 break-words text-sm text-gray-700">{value}</p>
        </div>
      ))}
    </div>
  );
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-gray-900">{title}</p>
      {children}
    </div>
  );
}

function TokenList({ values, variant }: { values: string[]; variant: 'amber' | 'slate' }) {
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => <Badge key={value} variant={variant}>{value}</Badge>)}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function phaseLabel(phase: HandshakeErrorLog['phase']) {
  const labels: Record<HandshakeErrorLog['phase'], string> = {
    config_fetch: 'Config fetch',
    config_domain: 'Config domain',
    jwt_verify: 'JWT verify',
    startup: 'Startup',
    token_exchange: 'Token exchange',
  };

  return labels[phase];
}
