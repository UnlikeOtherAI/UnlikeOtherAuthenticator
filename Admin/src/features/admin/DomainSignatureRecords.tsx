import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import { DataTable, Td } from '../../components/ui/Table';
import { adminService, type AgreementSignatureSearchInput } from '../../services/admin-service';
import { downloadBlob } from '../../utils/blob-download';
import { RevokeSignatureDialog } from './DomainAgreementForms';
import { useDomainAgreementSignaturesQuery } from './admin-queries';
import type { AgreementSignatureRecord, DomainAgreement } from './types';

const FilterSchema = z.object({
  query: z.string().trim().max(320),
  agreementId: z.string(),
  agreementVersionId: z.string(),
  from: z.string(),
  to: z.string(),
});
type FilterValues = z.infer<typeof FilterSchema>;

const emptyFilters: FilterValues = {
  query: '',
  agreementId: '',
  agreementVersionId: '',
  from: '',
  to: '',
};

export function DomainSignatureRecords({ agreements, domain }: { agreements: DomainAgreement[]; domain: string }) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<FilterValues>(emptyFilters);
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const [details, setDetails] = useState<AgreementSignatureRecord | null>(null);
  const [revoking, setRevoking] = useState<AgreementSignatureRecord | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const form = useForm<FilterValues>({ resolver: zodResolver(FilterSchema), defaultValues: emptyFilters });
  const selectedAgreementId = form.watch('agreementId');
  const versions = useMemo(
    () => agreements.find((agreement) => agreement.id === selectedAgreementId)?.versions ?? agreements.flatMap((agreement) => agreement.versions),
    [agreements, selectedAgreementId],
  );
  const searchInput = useMemo<AgreementSignatureSearchInput>(
    () => ({
      query: filters.query || undefined,
      agreementId: filters.agreementId || undefined,
      agreementVersionId: filters.agreementVersionId || undefined,
      from: dateBoundary(filters.from, false),
      to: dateBoundary(filters.to, true),
      cursor: pageCursors[page],
      limit: 50,
    }),
    [filters, page, pageCursors],
  );
  const records = useDomainAgreementSignaturesQuery(domain, searchInput);

  function search(values: FilterValues) {
    setFilters(values);
    setPage(0);
    setPageCursors([undefined]);
  }

  function clear() {
    form.reset(emptyFilters);
    setFilters(emptyFilters);
    setPage(0);
    setPageCursors([undefined]);
  }

  async function downloadReceipt(record: AgreementSignatureRecord) {
    setDownloadError(false);
    try {
      const blob = await adminService.downloadDomainAgreementSignatureReceipt(domain, record.id);
      downloadBlob(blob, `${safeFilename(record.agreement_title)}-v${record.agreement_version}-receipt.pdf`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'domain-signatures', domain] });
    } catch {
      setDownloadError(true);
    }
  }

  async function revoke(reason: string) {
    if (!revoking) throw new Error('No signature selected');
    await adminService.revokeDomainAgreementSignature(domain, revoking.id, reason);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'domain-signatures', domain] });
    setRevoking(null);
  }

  const rows = records.data?.data ?? [];
  const nextCursor = records.data?.next_cursor;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-5" onSubmit={form.handleSubmit(search)}>
          <FieldShell label="User or reference">
            <TextField {...form.register('query')} placeholder="Email, name, or reference" type="search" />
          </FieldShell>
          <FieldShell label="Agreement">
            <SelectField
              {...form.register('agreementId')}
              className="w-full"
              onChange={(event) => {
                form.setValue('agreementId', event.target.value);
                form.setValue('agreementVersionId', '');
              }}
            >
              <option value="">All agreements</option>
              {agreements.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.title}</option>)}
            </SelectField>
          </FieldShell>
          <FieldShell label="Version">
            <SelectField {...form.register('agreementVersionId')} className="w-full">
              <option value="">All versions</option>
              {versions.map((version) => <option key={version.id} value={version.id}>{version.title} · v{version.version}</option>)}
            </SelectField>
          </FieldShell>
          <FieldShell label="Signed from (UTC)">
            <TextField {...form.register('from')} type="date" />
          </FieldShell>
          <FieldShell label="Signed to (UTC)">
            <TextField {...form.register('to')} type="date" />
          </FieldShell>
          <div className="flex gap-2 md:col-span-2 xl:col-span-5">
            <Button type="submit" variant="primary" disabled={records.isFetching}>Search evidence</Button>
            <Button onClick={clear}>Clear</Button>
          </div>
        </form>
      </Card>

      {downloadError ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">The receipt could not be downloaded or failed its integrity check.</p> : null}
      {records.isError ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">Signature records could not be loaded. Check the filters and try again.</p> : null}

      <Card>
        <DataTable headers={['Signer', 'Agreement', 'Signed', 'Verification', 'State', 'Actions']}>
          {rows.map((record) => (
            <tr key={record.id}>
              <Td>
                <p className="font-medium text-gray-800">{record.signer_name || record.user_email}</p>
                <p className="text-xs text-gray-400">{record.user_email}</p>
              </Td>
              <Td>
                <p>{record.agreement_title}</p>
                <p className="text-xs text-gray-400">v{record.agreement_version} · {record.signing_method === 'typed_name' ? 'Typed name' : 'Click-wrap'}</p>
              </Td>
              <Td className="text-xs text-gray-500">{new Date(record.signed_at).toLocaleString()}</Td>
              <Td><code className="block max-w-40 truncate text-xs" title={record.verification_reference}>{record.verification_reference}</code></Td>
              <Td>
                <Badge variant={record.revocation ? 'red' : 'green'}>{record.revocation ? 'Revoked' : 'Valid'}</Badge>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => setDetails(record)}>Details</Button>
                  <Button icon="download" size="sm" onClick={() => void downloadReceipt(record)}>Receipt</Button>
                  {!record.revocation ? <Button size="sm" variant="danger" onClick={() => setRevoking(record)}>Revoke</Button> : null}
                </div>
              </Td>
            </tr>
          ))}
          {!records.isLoading && rows.length === 0 ? (
            <tr><Td colSpan={6} className="text-sm text-gray-400">No signatures match these filters.</Td></tr>
          ) : null}
          {records.isLoading ? (
            <tr><Td colSpan={6} className="text-sm text-gray-400">Loading signature evidence…</Td></tr>
          ) : null}
        </DataTable>
        <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
          <span className="text-xs text-gray-400">Page {page + 1} · up to 50 records</span>
          <div className="flex gap-2">
            <Button size="sm" disabled={page === 0 || records.isFetching} onClick={() => setPage((current) => current - 1)}>Previous</Button>
            <Button
              size="sm"
              disabled={!nextCursor || records.isFetching}
              onClick={() => {
                if (!nextCursor) return;
                const nextPage = page + 1;
                setPageCursors((current) => [...current.slice(0, nextPage), nextCursor]);
                setPage(nextPage);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>

      <SignatureDetailsModal record={details} onClose={() => setDetails(null)} />
      <RevokeSignatureDialog isOpen={Boolean(revoking)} onClose={() => setRevoking(null)} onRevoke={revoke} />
    </div>
  );
}

function SignatureDetailsModal({ record, onClose }: { record: AgreementSignatureRecord | null; onClose: () => void }) {
  if (!record) return null;
  const entries = [
    ['Verification reference', record.verification_reference],
    ['Source PDF SHA-256', record.source_pdf_sha256],
    ['Receipt PDF SHA-256', record.receipt_pdf_sha256],
    ['Evidence manifest SHA-256', record.evidence_manifest_sha256],
    ['Evidence key ID', record.evidence_key_id],
    ['User ID', record.user_id],
    ['Authentication method', record.auth_method],
    ['Two-factor completed', record.two_fa_completed ? 'Yes' : 'No'],
    ['IP address', record.ip_address],
    ['User agent', record.user_agent],
  ];
  return (
    <Modal isOpen onClose={onClose} title="Signature verification details" widthClassName="max-w-2xl" footer={<Button onClick={onClose}>Close</Button>}>
      <dl className="space-y-3">
        {entries.map(([label, value]) => (
          <div key={label} className="grid gap-1 border-b border-gray-100 pb-2 sm:grid-cols-[11rem_1fr]">
            <dt className="text-xs font-medium text-gray-500">{label}</dt>
            <dd className="break-all text-xs text-gray-800">{value}</dd>
          </div>
        ))}
        <div className="grid gap-1 border-b border-gray-100 pb-2 sm:grid-cols-[11rem_1fr]">
          <dt className="text-xs font-medium text-gray-500">Acceptance statement</dt>
          <dd className="text-xs text-gray-800">{record.acceptance_statement}</dd>
        </div>
        {record.typed_name ? (
          <div className="grid gap-1 border-b border-gray-100 pb-2 sm:grid-cols-[11rem_1fr]">
            <dt className="text-xs font-medium text-gray-500">Typed name</dt>
            <dd className="text-xs text-gray-800">{record.typed_name}</dd>
          </div>
        ) : null}
        {record.revocation ? (
          <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
            Revoked by {record.revocation.actor_email} on {new Date(record.revocation.revoked_at).toLocaleString()}: {record.revocation.reason}
          </div>
        ) : null}
      </dl>
    </Modal>
  );
}

function dateBoundary(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString();
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-') || 'agreement';
}
