import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { SelectField, TextField } from '../components/ui/FormFields';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { DataTable, PaginationFooter, Td, usePagination } from '../components/ui/Table';
import {
  useIntegrationRequestQuery,
  useIntegrationRequestsQuery,
} from '../features/admin/admin-queries';
import { useAdminUi } from '../features/shell/admin-ui';
import { adminService } from '../services/admin-service';
import type {
  IntegrationClaimCredentials,
  IntegrationClaimDeliveryMode,
  IntegrationRequestDetail,
  IntegrationRequestStatus,
  IntegrationRequestSummary,
} from '../features/admin/types';
import {
  AcceptIntegrationModal,
  CredentialsRevealModal,
  DeclineIntegrationModal,
} from './integration-request-modals';

type StatusFilter = 'ALL' | IntegrationRequestStatus;

const statusBadgeVariant: Record<IntegrationRequestStatus, 'amber' | 'green' | 'red'> = {
  PENDING: 'amber',
  ACCEPTED: 'green',
  DECLINED: 'red',
};

export function IntegrationRequestsPage() {
  const [params, setParams] = useSearchParams();
  const statusValue = params.get('status');
  const status: StatusFilter = statusValue === 'ALL' || statusValue === 'ACCEPTED' || statusValue === 'DECLINED' ? statusValue : 'PENDING';
  const query = params.get('q') ?? '';
  const selectedId = params.get('request');
  function filter(key: string, value: string) {
    setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); next.delete('page'); return next; }, { replace: key !== 'request' });
  }
  const { data = [], isLoading, isError, refetch } = useIntegrationRequestsQuery(status === 'ALL' ? undefined : status);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return data;
    return data.filter((row) =>
      [row.domain, row.contact_email, row.jwk_fingerprint].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
    );
  }, [data, query]);

  const { pageItems, pagination } = usePagination(filtered);

  return (
    <>
      <PageHeader description=""
        title="Integration requests"
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-gray-100 px-4 py-3">
          <TextField
            aria-label="Search integration requests"
            className="w-60"
            placeholder="Filter by domain, contact, fingerprint..."
            type="search"
            value={query}
            onChange={(event) => filter('q', event.target.value)}
          />
          <SelectField aria-label="Request status" value={status} onChange={(event) => filter('status', event.target.value)}>
            <option value="ALL">All</option>
            <option value="PENDING">Pending</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="DECLINED">Declined</option>
          </SelectField>
        </div>
        {isError ? <p role="alert" className="p-5">Could not load requests. <Button onClick={() => refetch()}>Retry</Button></p> : isLoading ? (
          <p className="px-5 py-6 text-sm text-gray-400">Loading integration requests...</p>
        ) : (
          <>
            <DataTable headers={['Service', 'Submitted', 'Status', 'Contact']}>
              {pageItems.map((row) => (
                <IntegrationRow
                  key={row.id}
                  row={row}
                  href={`?${new URLSearchParams({ ...Object.fromEntries(params), request: row.id })}`}
                />
              ))}
              {pageItems.length === 0 ? (
                <tr>
                  <Td colSpan={4} className="text-sm text-gray-400">
                    No integration requests match the filters.
                  </Td>
                </tr>
              ) : null}
            </DataTable>
            <PaginationFooter {...pagination} />
          </>
        )}
      </Card>
      <IntegrationDetailPanel
        id={selectedId}
        onClose={() => filter('request', '')}
      />
    </>
  );
}

function IntegrationRow({ row, href }: { row: IntegrationRequestSummary; href: string }) {
  return (
    <tr
      className="cursor-pointer transition-colors hover:bg-gray-50"
    >
      <Td>
        <Link className="font-medium text-indigo-600 hover:underline" to={href}>{row.domain}</Link>
        <p className="mt-0.5 truncate text-xs text-gray-400">kid: {row.kid}</p>
      </Td>
      <Td className="text-xs text-gray-500">{formatIso(row.submitted_at)}</Td>
      <Td>
        <Badge variant={statusBadgeVariant[row.status]}>{row.status.toLowerCase()}</Badge>
      </Td>
      <Td>{row.contact_email}</Td>
    </tr>
  );
}

function IntegrationDetailPanel({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading, isError, refetch } = useIntegrationRequestQuery(id);
  const isOpen = Boolean(id);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Integration Request"
      widthClassName="max-w-2xl"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {isError ? <p role="alert">Could not load this request. <Button onClick={() => refetch()}>Retry</Button></p> : isLoading || !data ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <IntegrationDetailBody detail={data} onDone={onClose} />
      )}
    </Modal>
  );
}

function IntegrationDetailBody({
  detail,
  onDone,
}: {
  detail: IntegrationRequestDetail;
  onDone: () => void;
}) {
  return (
    <div className="space-y-5">
      <DetailSection title="Identity">
        <DetailRow label="Domain" value={detail.domain} mono />
        <DetailRow label="Contact" value={detail.contact_email} />
        <DetailRow label="Fingerprint" value={detail.jwk_fingerprint} mono />
        <DetailRow label="Kid" value={detail.kid} mono />
        <DetailRow
          label="Status"
          value={<Badge variant={statusBadgeVariant[detail.status]}>{detail.status.toLowerCase()}</Badge>}
        />
        <DetailRow label="Submitted" value={formatIso(detail.submitted_at)} />
        <DetailRow label="Last seen" value={formatIso(detail.last_seen_at)} />
        {detail.reviewed_at ? (
          <DetailRow
            label="Reviewed"
            value={`${formatIso(detail.reviewed_at)} by ${detail.reviewed_by_email ?? '—'}`}
          />
        ) : null}
        {detail.decline_reason ? <DetailRow label="Decline reason" value={detail.decline_reason} /> : null}
      </DetailSection>

      <DetailSection title="Source">
        <DetailRow label="JWKS URL" value={detail.jwks_url} mono />
        {detail.config_url ? <DetailRow label="Config URL" value={detail.config_url} mono /> : null}
      </DetailSection>

      {detail.status === 'ACCEPTED' ? <Link to={`/domains/${encodeURIComponent(detail.domain)}`} className="text-indigo-600 hover:underline">Open website service</Link> : null}
      <details><summary className="cursor-pointer text-sm font-medium">Technical review details</summary>
      <DetailSection title="Public JWK">
        <JsonBlock value={detail.public_jwk} />
      </DetailSection>

      {detail.config_summary ? (
        <DetailSection title="Verified Config Summary">
          <JsonBlock value={detail.config_summary} />
        </DetailSection>
      ) : null}

      {detail.pre_validation_result ? (
        <DetailSection title="Pre-validation">
          <JsonBlock value={detail.pre_validation_result} />
        </DetailSection>
      ) : null}

      </details>
      <DetailSection title="Decision">
        <IntegrationDecisionControls detail={detail} onDone={onDone} />
      </DetailSection>
    </div>
  );
}

function IntegrationDecisionControls({
  detail,
  onDone,
}: {
  detail: IntegrationRequestDetail;
  onDone: () => void;
}) {
  const { confirm } = useAdminUi();
  const queryClient = useQueryClient();
  const [showAccept, setShowAccept] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [revealCredentials, setRevealCredentials] = useState<IntegrationClaimCredentials | null>(null);

  const acceptMutation = useMutation({
    mutationFn: (input: {
      label?: string;
      clientSecret?: string;
      deliveryMode: IntegrationClaimDeliveryMode;
    }) => adminService.acceptIntegrationRequest(detail.id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const declineMutation = useMutation({
    mutationFn: (reason: string) => adminService.declineIntegrationRequest(detail.id, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const resendMutation = useMutation({
    mutationFn: (deliveryMode: IntegrationClaimDeliveryMode) =>
      adminService.resendIntegrationClaim(detail.id, deliveryMode),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const deleteMutation = useMutation({
    mutationFn: () => adminService.deleteIntegrationRequest(detail.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });

  function runDelete() {
    confirm(
      `Delete integration for ${detail.domain}?`,
      'This removes the request record. The registered website service is retained.',
      async () => {
        await deleteMutation.mutateAsync();
        onDone();
      },
    );
  }

  function runResendEmail() {
    confirm(
      `Email claim link to ${detail.contact_email}?`,
      'A fresh 24h one-time claim link will be emailed.',
      async () => {
        await resendMutation.mutateAsync('email');
      },
    );
  }

  function runResendReveal() {
    confirm(
      `Reveal client secret for ${detail.domain}?`,
      'The secret will be shown once in this admin. Copy it now; closing the dialog without saving it requires a rotate.',
      async () => {
        const result = await resendMutation.mutateAsync('reveal');
        if (result.credentials) setRevealCredentials(result.credentials);
      },
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {detail.status === 'PENDING' ? (
        <>
          <Button icon="check" variant="primary" onClick={() => setShowAccept(true)}>
            Accept
          </Button>
          <Button variant="danger" onClick={() => setShowDecline(true)}>
            Decline
          </Button>
        </>
      ) : null}
      {detail.status === 'ACCEPTED' ? (
        <>
          <Button icon="key" variant="primary" onClick={runResendReveal}>
            Reveal Secret Here
          </Button>
          <Button icon="bell" onClick={runResendEmail}>
            Email Claim Link
          </Button>
        </>
      ) : null}
      {detail.status !== 'PENDING' ? (
        <Button variant="danger" onClick={runDelete}>
          Delete
        </Button>
      ) : null}
      <AcceptIntegrationModal
        detail={detail}
        isOpen={showAccept}
        onClose={() => setShowAccept(false)}
        onSubmit={async (input) => {
          const result = await acceptMutation.mutateAsync(input);
          setShowAccept(false);
          if (input.deliveryMode === 'reveal' && result.credentials) {
            setRevealCredentials(result.credentials);
          }
        }}
      />
      <DeclineIntegrationModal
        detail={detail}
        isOpen={showDecline}
        onClose={() => setShowDecline(false)}
        onSubmit={async (reason) => {
          await declineMutation.mutateAsync(reason);
          setShowDecline(false);
        }}
      />
      <CredentialsRevealModal
        credentials={revealCredentials}
        isOpen={Boolean(revealCredentials)}
        onClose={() => setRevealCredentials(null)}
      />
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      <div className="space-y-1.5 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-28 shrink-0 text-xs font-medium text-gray-500">{label}</span>
      <span className={mono ? 'min-w-0 flex-1 break-all font-mono text-xs text-gray-700' : 'min-w-0 flex-1 text-gray-700'}>
        {value}
      </span>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg border border-gray-100 bg-white px-3 py-2 text-xs text-gray-700">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function formatIso(value: string): string {
  return new Date(value).toLocaleString(undefined, { timeZoneName: 'short' });
}
