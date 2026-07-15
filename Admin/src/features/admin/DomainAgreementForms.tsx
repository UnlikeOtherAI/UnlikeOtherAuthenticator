import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextAreaField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import type { AgreementInput, AgreementVersionInput } from '../../services/admin-service';
import type { DomainAgreement, DomainAgreementVersion } from './types';

const AgreementSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title.').max(200),
  description: z.string().trim().max(1000),
  displayOrder: z.number().int().min(0).max(100_000),
  requiredForAccess: z.boolean(),
});

type AgreementFormValues = z.infer<typeof AgreementSchema>;

export function AgreementDialog({
  initial,
  isOpen,
  onClose,
  onSave,
}: {
  initial: DomainAgreement | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (input: AgreementInput) => Promise<void>;
}) {
  const [serverError, setServerError] = useState(false);
  const form = useForm<AgreementFormValues>({
    resolver: zodResolver(AgreementSchema),
    defaultValues: agreementDefaults(initial),
  });

  useEffect(() => {
    form.reset(agreementDefaults(initial));
    setServerError(false);
  }, [form, initial, isOpen]);

  async function submit(values: AgreementFormValues) {
    setServerError(false);
    try {
      await onSave({
        ...values,
        title: values.title.trim(),
        description: values.description.trim() || null,
      });
      onClose();
    } catch {
      setServerError(true);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={initial ? 'Edit agreement' : 'Create agreement'}
      footer={
        <>
          <Button disabled={form.formState.isSubmitting} onClick={onClose}>Cancel</Button>
          <Button form="agreement-form" type="submit" variant="primary" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : 'Save agreement'}
          </Button>
        </>
      }
    >
      <form id="agreement-form" className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <FieldShell label="Agreement title" error={form.formState.errors.title?.message}>
          <TextField {...form.register('title')} autoFocus />
        </FieldShell>
        <FieldShell label="Description" error={form.formState.errors.description?.message}>
          <TextAreaField {...form.register('description')} rows={3} />
        </FieldShell>
        <FieldShell label="Display order" error={form.formState.errors.displayOrder?.message} hint="Lower numbers are presented first.">
          <TextField {...form.register('displayOrder', { valueAsNumber: true })} min={0} max={100000} type="number" />
        </FieldShell>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input {...form.register('requiredForAccess')} className="mt-0.5 h-4 w-4 rounded border-gray-300" disabled={Boolean(initial)} type="checkbox" />
          <span>
            <span className="font-medium">Required for access</span>
            <span className="block text-xs text-gray-400">
              {initial ? 'Change this separately from the agreement card so the access impact is confirmed.' : 'Users must sign the active published version before authorization.'}
            </span>
          </span>
        </label>
        {serverError ? <p className="text-xs text-red-600">The agreement could not be saved. Review the current domain policy and try again.</p> : null}
      </form>
    </Modal>
  );
}

const VersionSchema = z.object({
  title: z.string().trim().min(1, 'Enter the signer-facing title.').max(200),
  signingMethod: z.enum(['clickwrap', 'typed_name']),
  acceptanceStatement: z.string().trim().min(1, 'Enter the acceptance statement.').max(4000),
});

type VersionFormValues = z.infer<typeof VersionSchema>;

export function AgreementVersionDialog({
  initial,
  isOpen,
  onClose,
  onSave,
}: {
  initial: DomainAgreementVersion | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (input: AgreementVersionInput, file: File | null) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [serverError, setServerError] = useState(false);
  const form = useForm<VersionFormValues>({
    resolver: zodResolver(VersionSchema),
    defaultValues: versionDefaults(initial),
  });

  useEffect(() => {
    form.reset(versionDefaults(initial));
    setFile(null);
    setFileError('');
    setServerError(false);
  }, [form, initial, isOpen]);

  async function submit(values: VersionFormValues) {
    if (!initial && !file) {
      setFileError('Choose a PDF to upload.');
      return;
    }
    setServerError(false);
    try {
      await onSave(
        {
          title: values.title.trim(),
          signingMethod: values.signingMethod,
          acceptanceStatement: values.acceptanceStatement.trim(),
        },
        file,
      );
      onClose();
    } catch {
      setServerError(true);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={initial ? `Edit draft v${initial.version}` : 'Upload agreement version'}
      footer={
        <>
          <Button disabled={form.formState.isSubmitting} onClick={onClose}>Cancel</Button>
          <Button form="agreement-version-form" type="submit" variant="primary" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : initial ? 'Save draft' : 'Upload draft'}
          </Button>
        </>
      }
    >
      <form id="agreement-version-form" className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        {!initial ? (
          <FieldShell label="Source PDF" error={fileError} hint="Only a validated PDF is stored; active content and unsafe structure are rejected.">
            <TextField
              accept="application/pdf,.pdf"
              type="file"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setFileError('');
              }}
            />
          </FieldShell>
        ) : null}
        <FieldShell label="Signer-facing title" error={form.formState.errors.title?.message}>
          <TextField {...form.register('title')} autoFocus={Boolean(initial)} />
        </FieldShell>
        <FieldShell label="Signing method" error={form.formState.errors.signingMethod?.message}>
          <SelectField {...form.register('signingMethod')} className="w-full">
            <option value="clickwrap">Click-wrap acceptance</option>
            <option value="typed_name">Typed name</option>
          </SelectField>
        </FieldShell>
        <FieldShell label="Acceptance statement" error={form.formState.errors.acceptanceStatement?.message} hint="This exact text becomes part of the signed evidence.">
          <TextAreaField {...form.register('acceptanceStatement')} rows={4} />
        </FieldShell>
        {serverError ? <p className="text-xs text-red-600">The draft could not be saved. Confirm the PDF and metadata, then try again.</p> : null}
      </form>
    </Modal>
  );
}

export function ReplaceAgreementPdfDialog({
  isOpen,
  onClose,
  onReplace,
  version,
}: {
  isOpen: boolean;
  onClose: () => void;
  onReplace: (file: File) => Promise<void>;
  version: DomainAgreementVersion | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setFile(null);
    setError('');
  }, [isOpen, version]);

  async function replace() {
    if (!file) {
      setError('Choose a replacement PDF.');
      return;
    }
    setPending(true);
    setError('');
    try {
      await onReplace(file);
      onClose();
    } catch {
      setError('The PDF could not be replaced.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Replace draft PDF${version ? ` for v${version.version}` : ''}`}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>Cancel</Button>
          <Button disabled={pending} variant="danger" onClick={replace}>{pending ? 'Replacing…' : 'Replace PDF'}</Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-gray-500">This permanently replaces the current draft source and recalculates its SHA-256 hash. Published versions cannot be changed.</p>
      <FieldShell label="Replacement PDF" error={error}>
        <TextField accept="application/pdf,.pdf" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      </FieldShell>
    </Modal>
  );
}

const RevokeSchema = z.object({ reason: z.string().trim().min(1, 'A reason is required.').max(1000) });
type RevokeValues = z.infer<typeof RevokeSchema>;

export function RevokeSignatureDialog({
  isOpen,
  onClose,
  onRevoke,
}: {
  isOpen: boolean;
  onClose: () => void;
  onRevoke: (reason: string) => Promise<void>;
}) {
  const [serverError, setServerError] = useState(false);
  const form = useForm<RevokeValues>({ resolver: zodResolver(RevokeSchema), defaultValues: { reason: '' } });

  useEffect(() => {
    form.reset({ reason: '' });
    setServerError(false);
  }, [form, isOpen]);

  async function submit(values: RevokeValues) {
    setServerError(false);
    try {
      await onRevoke(values.reason.trim());
      onClose();
    } catch {
      setServerError(true);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Revoke signature"
      footer={
        <>
          <Button disabled={form.formState.isSubmitting} onClick={onClose}>Cancel</Button>
          <Button form="revoke-signature-form" type="submit" variant="danger" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Revoking…' : 'Revoke signature'}
          </Button>
        </>
      }
    >
      <form id="revoke-signature-form" className="space-y-4" onSubmit={form.handleSubmit(submit)}>
        <p className="text-sm text-gray-500">The original signature and receipt remain immutable. Revocation adds a permanent history record and no longer satisfies the access requirement.</p>
        <FieldShell label="Required reason" error={form.formState.errors.reason?.message}>
          <TextAreaField {...form.register('reason')} autoFocus rows={4} />
        </FieldShell>
        {serverError ? <p className="text-xs text-red-600">The signature could not be revoked. Refresh the records and try again.</p> : null}
      </form>
    </Modal>
  );
}

function agreementDefaults(initial: DomainAgreement | null): AgreementFormValues {
  return {
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    displayOrder: initial?.display_order ?? 0,
    requiredForAccess: initial?.required_for_access ?? true,
  };
}

function versionDefaults(initial: DomainAgreementVersion | null): VersionFormValues {
  return {
    title: initial?.title ?? '',
    signingMethod: initial?.signing_method ?? 'clickwrap',
    acceptanceStatement: initial?.acceptance_statement ?? 'I agree to the terms of this agreement.',
  };
}
