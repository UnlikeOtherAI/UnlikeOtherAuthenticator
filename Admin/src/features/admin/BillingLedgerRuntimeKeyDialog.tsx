import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/Button';
import { FieldShell, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import type { BillingService } from '../../schemas/billing';
import { BillingLedgerRuntimeKeyFormSchema, type BillingLedgerRuntimeKeyFormValues,
  type CreatedBillingLedgerRuntimeKey } from '../../schemas/billing-ledger-runtime-keys';
import { billingLedgerRuntimeKeyService } from '../../services/billing-ledger-runtime-key-service';
import { billingLedgerRuntimeKeysKey } from './billing-ledger-runtime-key-queries';

export function BillingLedgerRuntimeKeyDialog({ service, onClose }: {
  service: BillingService; onClose: () => void;
}) {
  const client = useQueryClient();
  const alive = useRef(true);
  const issuing = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [created, setCreated] = useState<CreatedBillingLedgerRuntimeKey | null>(null);
  const [scope, setScope] = useState<BillingLedgerRuntimeKeyFormValues | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const form = useForm<BillingLedgerRuntimeKeyFormValues>({
    resolver: zodResolver(BillingLedgerRuntimeKeyFormSchema),
    defaultValues: { sourceDomain: '', ledgerAudience: '' },
  });
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function submit(values: BillingLedgerRuntimeKeyFormValues) {
    if (issuing.current || !service.active) return;
    issuing.current = true;
    setPending(true);
    setError(false);
    try {
      const result = await billingLedgerRuntimeKeyService.create(service.identifier, values);
      if (!alive.current) return; // Navigation/logout cannot revive the one-time reveal.
      setScope({ ...values, sourceDomain: values.sourceDomain.toLowerCase() });
      setCreated(result);
      void client.invalidateQueries({ queryKey: billingLedgerRuntimeKeysKey });
    } catch {
      if (alive.current) setError(true);
    } finally {
      issuing.current = false;
      if (alive.current) setPending(false);
    }
  }
  function close() { setCreated(null); setScope(null); onClose(); }
  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.secret);
      if (alive.current) setCopyStatus('copied');
    } catch {
      if (alive.current) setCopyStatus('failed');
    }
  }
  return <Modal isOpen onClose={close} isPending={pending}
    isDirty={!created && form.formState.isDirty}
    title={created ? 'Ledger runtime key issued' : `Issue Ledger runtime key · ${service.name}`}
    widthClassName="max-w-2xl"
    footer={created ? <Button variant="primary" onClick={close}>I have stored this key</Button>
      : <Button icon="key" variant="primary" disabled={pending || !service.active}
        onClick={form.handleSubmit(submit)}>{pending ? 'Issuing...' : 'Issue runtime key'}</Button>}>
    {created && scope ? <div className="space-y-4">
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        Shown once. Store this key in the approved Ledger secret store for {service.identifier}.
        UOA stores only a digest and cannot reveal it again. Closing this dialog clears the reveal.
      </p>
      <dl className="space-y-2 text-sm">
        <div><dt className="text-gray-500">Product</dt><dd>{service.identifier}</dd></div>
        <div><dt className="text-gray-500">Source domain</dt>
          <dd className="break-all font-mono">{scope.sourceDomain}</dd></div>
        <div><dt className="text-gray-500">Ledger audience</dt>
          <dd className="break-all font-mono">{scope.ledgerAudience}</dd></div>
        <div><dt className="text-gray-500">Key ID</dt><dd className="break-all">{created.id}</dd></div>
      </dl>
      <div className="flex flex-wrap items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-gray-950 p-3 text-xs text-green-300">
          {created.secret}</code>
        <Button icon="copy" onClick={() => void copy()}>
          {copyStatus === 'copied' ? 'Copied' : 'Copy key'}</Button>
      </div>
      {copyStatus === 'failed' ? <p role="alert" className="text-sm text-red-600">
        Could not copy. Select the key and copy it manually before closing.</p> : null}
    </div> : <form className="space-y-4" onSubmit={form.handleSubmit(submit)}>
      <FieldShell label="Product" hint="This key can authorize only this product.">
        <TextField value={service.identifier} readOnly /></FieldShell>
      <FieldShell label="Source domain" hint="The original product config domain, such as api.nessie.works."
        error={form.formState.errors.sourceDomain?.message}>
        <TextField {...form.register('sourceDomain')} autoComplete="off" placeholder="api.nessie.works" />
      </FieldShell>
      <FieldShell label="Ledger audience" hint="The exact HTTPS Ledger origin that will hold this key."
        error={form.formState.errors.ledgerAudience?.message}>
        <TextField {...form.register('ledgerAudience')} autoComplete="off"
          placeholder="https://ledger.unlikeotherai.com" />
      </FieldShell>
      <p className="text-sm text-gray-500">
        Review all three values before issuing. This creates a new credential; it does not install
        it in Ledger or change delegation permissions. The secret is shown only after issuance.
      </p>
      {error ? <p role="alert" className="text-sm text-red-600">
        Could not confirm runtime-key issuance. Check the key list before retrying: a lost response
        may still have created a key. Revoke any unused key before issuing a replacement.</p> : null}
    </form>}
  </Modal>;
}
