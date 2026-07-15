import { useState } from 'react';

import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { DataTable, Td } from '../../components/ui/Table';
import { useAdminUi } from '../shell/admin-ui';
import { adminService, type AgreementInput, type AgreementVersionInput } from '../../services/admin-service';
import { downloadBlob, previewPdfBlob } from '../../utils/blob-download';
import {
  AgreementDialog,
  AgreementVersionDialog,
  ReplaceAgreementPdfDialog,
} from './DomainAgreementForms';
import type { DomainAgreement, DomainAgreementVersion } from './types';

type Props = {
  agreements: DomainAgreement[];
  domain: string;
  enabled: boolean;
  refresh: () => Promise<void>;
};

export function DomainAgreementManager({ agreements, domain, enabled, refresh }: Props) {
  const { confirm } = useAdminUi();
  const [agreementDialog, setAgreementDialog] = useState<DomainAgreement | 'new' | null>(null);
  const [versionAgreement, setVersionAgreement] = useState<DomainAgreement | null>(null);
  const [editingVersion, setEditingVersion] = useState<{ agreement: DomainAgreement; version: DomainAgreementVersion } | null>(null);
  const [replacement, setReplacement] = useState<{ agreement: DomainAgreement; version: DomainAgreementVersion } | null>(null);
  const [operationError, setOperationError] = useState(false);

  async function update(action: () => Promise<unknown>) {
    setOperationError(false);
    try {
      await action();
      await refresh();
    } catch (error) {
      setOperationError(true);
      throw error;
    }
  }

  async function saveAgreement(input: AgreementInput) {
    if (agreementDialog === 'new') {
      await update(() => adminService.createDomainAgreement(domain, input));
    } else if (agreementDialog) {
      await update(() => adminService.updateDomainAgreement(domain, agreementDialog.id, input));
    }
  }

  async function saveVersion(input: AgreementVersionInput, file: File | null) {
    if (editingVersion) {
      await update(() =>
        adminService.updateDomainAgreementVersion(
          domain,
          editingVersion.agreement.id,
          editingVersion.version.id,
          input,
        ),
      );
      return;
    }
    if (!versionAgreement || !file) throw new Error('Missing agreement version upload');
    await update(() => adminService.uploadDomainAgreementVersion(domain, versionAgreement.id, file, input));
  }

  function confirmed(title: string, body: string, action: () => Promise<unknown>) {
    confirm(title, body, async () => {
      try {
        await update(action);
      } catch {
        // The persistent inline error is shown after the confirmation closes.
      }
    });
  }

  async function readSource(
    agreement: DomainAgreement,
    version: DomainAgreementVersion,
    mode: 'download' | 'preview',
  ) {
    setOperationError(false);
    try {
      const blob = await adminService.downloadDomainAgreementVersionSource(domain, agreement.id, version.id);
      if (mode === 'preview') {
        previewPdfBlob(blob);
      } else {
        downloadBlob(blob, version.original_filename);
      }
    } catch {
      setOperationError(true);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">Published versions are immutable. Upload changes as a new draft version.</p>
        <Button icon="plus" variant="primary" size="sm" onClick={() => setAgreementDialog('new')}>New agreement</Button>
      </div>

      {operationError ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">The operation could not be completed. The domain policy may have changed; refresh and try again.</p>
      ) : null}

      {agreements.map((agreement) => (
        <Card key={agreement.id}>
          <CardHeader>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-900">{agreement.title}</h3>
                <Badge variant={agreement.required_for_access ? 'purple' : 'slate'}>
                  {agreement.required_for_access ? 'Required' : 'Optional'}
                </Badge>
                <Badge>Order {agreement.display_order}</Badge>
              </div>
              <p className="mt-1 text-xs text-gray-400">{agreement.description || 'No description'}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" onClick={() => setAgreementDialog(agreement)}>Edit</Button>
              <Button
                size="sm"
                onClick={() =>
                  confirmed(
                    agreement.required_for_access ? 'Make agreement optional?' : 'Require agreement for access?',
                    agreement.required_for_access
                      ? 'Users will no longer need this agreement for authorization. At least one other active required agreement must remain while the service is enabled.'
                      : 'Users will need the current published version before authorization. A valid active version is required.',
                    () =>
                      adminService.updateDomainAgreement(domain, agreement.id, {
                        title: agreement.title,
                        description: agreement.description,
                        displayOrder: agreement.display_order,
                        requiredForAccess: !agreement.required_for_access,
                      }),
                  )
                }
              >
                {agreement.required_for_access ? 'Make optional' : 'Require for access'}
              </Button>
              <Button icon="plus" size="sm" variant="primary" onClick={() => setVersionAgreement(agreement)}>Upload version</Button>
            </div>
          </CardHeader>
          <VersionTable
            agreement={agreement}
            enabled={enabled}
            onDelete={(version) =>
              confirmed(
                `Delete draft v${version.version}?`,
                'The private source PDF and draft metadata will be permanently deleted.',
                () => adminService.deleteDomainAgreementVersion(domain, agreement.id, version.id),
              )
            }
            onDownload={(version) => void readSource(agreement, version, 'download')}
            onEdit={(version) => setEditingVersion({ agreement, version })}
            onPreview={(version) => void readSource(agreement, version, 'preview')}
            onPublish={(version) =>
              confirmed(
                `Publish v${version.version}?`,
                agreement.required_for_access
                  ? 'This makes the version immutable, supersedes the current version, and requires it at the next authorization when the service is enabled.'
                  : 'This makes the version immutable and supersedes the current published version.',
                () => adminService.publishDomainAgreementVersion(domain, agreement.id, version.id),
              )
            }
            onReplace={(version) => setReplacement({ agreement, version })}
            onWithdraw={(version) =>
              confirmed(
                `Withdraw v${version.version}?`,
                'The version remains retained but cannot be used for new signatures. Disable the service first when this is a required agreement.',
                () => adminService.withdrawDomainAgreementVersion(domain, agreement.id, version.id),
              )
            }
          />
        </Card>
      ))}

      {agreements.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-medium text-gray-700">No agreements configured</p>
          <p className="mt-1 text-xs text-gray-400">Create an agreement, upload a safe PDF draft, then publish it before enabling the service.</p>
        </Card>
      ) : null}

      <AgreementDialog
        initial={agreementDialog === 'new' ? null : agreementDialog}
        isOpen={agreementDialog !== null}
        onClose={() => setAgreementDialog(null)}
        onSave={saveAgreement}
      />
      <AgreementVersionDialog
        initial={editingVersion?.version ?? null}
        isOpen={Boolean(versionAgreement || editingVersion)}
        onClose={() => {
          setVersionAgreement(null);
          setEditingVersion(null);
        }}
        onSave={saveVersion}
      />
      <ReplaceAgreementPdfDialog
        isOpen={Boolean(replacement)}
        version={replacement?.version ?? null}
        onClose={() => setReplacement(null)}
        onReplace={(file) => {
          if (!replacement) throw new Error('Missing draft replacement');
          return update(() =>
            adminService.replaceDomainAgreementVersionSource(
              domain,
              replacement.agreement.id,
              replacement.version.id,
              file,
            ),
          );
        }}
      />
    </div>
  );
}

function VersionTable({
  agreement,
  enabled,
  onDelete,
  onDownload,
  onEdit,
  onPreview,
  onPublish,
  onReplace,
  onWithdraw,
}: {
  agreement: DomainAgreement;
  enabled: boolean;
  onDelete: (version: DomainAgreementVersion) => void;
  onDownload: (version: DomainAgreementVersion) => void;
  onEdit: (version: DomainAgreementVersion) => void;
  onPreview: (version: DomainAgreementVersion) => void;
  onPublish: (version: DomainAgreementVersion) => void;
  onReplace: (version: DomainAgreementVersion) => void;
  onWithdraw: (version: DomainAgreementVersion) => void;
}) {
  return (
    <DataTable headers={['Version', 'Method', 'Source SHA-256', 'Published', 'Signatures', 'Actions']}>
      {agreement.versions.map((version) => (
        <tr key={version.id}>
          <Td>
            <div className="flex items-center gap-2">
              <span className="font-semibold">v{version.version}</span>
              <Badge variant={statusTone(version.status)}>{version.status}</Badge>
            </div>
            <p className="mt-0.5 max-w-52 truncate text-xs text-gray-400" title={version.title}>{version.title}</p>
          </Td>
          <Td className="text-xs">{version.signing_method === 'typed_name' ? 'Typed name' : 'Click-wrap'}</Td>
          <Td><code className="block max-w-48 truncate text-xs text-gray-500" title={version.source_pdf_sha256}>{version.source_pdf_sha256}</code></Td>
          <Td className="text-xs text-gray-400">{version.published_at ? new Date(version.published_at).toLocaleString() : '—'}</Td>
          <Td>{version.signature_count ?? 0}</Td>
          <Td>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => onPreview(version)}>Preview</Button>
              <Button icon="download" size="sm" onClick={() => onDownload(version)}>Source</Button>
              {version.status === 'draft' ? <Button size="sm" onClick={() => onEdit(version)}>Edit</Button> : null}
              {version.status === 'draft' ? <Button size="sm" onClick={() => onReplace(version)}>Replace PDF</Button> : null}
              {version.status === 'draft' ? <Button size="sm" variant="primary" onClick={() => onPublish(version)}>Publish</Button> : null}
              {version.status === 'draft' ? <Button size="sm" variant="danger" onClick={() => onDelete(version)}>Delete</Button> : null}
              {version.status === 'published' ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={enabled && agreement.required_for_access}
                  title={enabled && agreement.required_for_access ? 'Disable the signature service before withdrawing a required version.' : undefined}
                  onClick={() => onWithdraw(version)}
                >
                  Withdraw
                </Button>
              ) : null}
            </div>
          </Td>
        </tr>
      ))}
      {agreement.versions.length === 0 ? (
        <tr><Td colSpan={6} className="text-sm text-gray-400">No versions uploaded.</Td></tr>
      ) : null}
    </DataTable>
  );
}

function statusTone(status: DomainAgreementVersion['status']): BadgeVariant {
  if (status === 'published') return 'green';
  if (status === 'draft') return 'blue';
  if (status === 'withdrawn') return 'red';
  return 'slate';
}
