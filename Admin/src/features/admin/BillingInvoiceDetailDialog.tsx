import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Badge, type BadgeVariant } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextAreaField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import {
  BillingInvoicePaymentFormSchema,
  type BillingInvoice,
  type BillingInvoicePaymentFormValues,
} from '../../schemas/billing-contracts';
import { billingContractAdminService } from '../../services/billing-contract-admin-service';
import { downloadBlob } from '../../utils/blob-download';
import {
  useIssueBillingInvoiceMutation,
  useRecordBillingInvoicePaymentMutation,
  useVoidBillingInvoiceMutation,
} from './billing-contract-queries';

function nowForInput(): string {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function statusVariant(status: BillingInvoice['status']): BadgeVariant {
  if (status === 'issued') return 'green';
  if (status === 'void') return 'red';
  if (status === 'issuing') return 'amber';
  return 'slate';
}

type PaymentKind = BillingInvoicePaymentFormValues['kind'];

const paymentKinds: PaymentKind[] = ['payment', 'refund', 'write_off'];

function availablePaymentKinds(invoice: BillingInvoice | null): PaymentKind[] {
  if (!invoice) return [];
  return paymentKinds.filter((kind) => invoice.actions.payment_limits[kind] !== null);
}

function paymentKindLabel(kind: PaymentKind): string {
  if (kind === 'write_off') return 'Write-off';
  return kind[0].toUpperCase() + kind.slice(1);
}

function displayUtcDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

function displayInstant(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function ActionError({ value }: { value: unknown }) {
  if (!value) return null;
  return (
    <p className="text-sm text-red-600">
      {value instanceof Error ? value.message : 'The invoice action failed.'}
    </p>
  );
}

export function BillingInvoiceDetailDialog({
  invoice,
  onClose,
}: {
  invoice: BillingInvoice | null;
  onClose: () => void;
}) {
  const issue = useIssueBillingInvoiceMutation();
  const voidInvoice = useVoidBillingInvoiceMutation();
  const recordPayment = useRecordBillingInvoicePaymentMutation();
  const [voidReason, setVoidReason] = useState('');
  const [showVoid, setShowVoid] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [showIssueConfirm, setShowIssueConfirm] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const resetIssue = issue.reset;
  const resetVoid = voidInvoice.reset;
  const resetPayment = recordPayment.reset;
  const invoiceId = invoice?.id ?? '';
  const invoiceCurrency = invoice?.currency ?? 'USD';
  const initialPaymentKind = availablePaymentKinds(invoice)[0] ?? 'payment';
  const invoiceActionRevision = invoice
    ? [
        invoice.status,
        invoice.actions.issue,
        invoice.actions.download_pdf,
        invoice.actions.void,
        ...paymentKinds.map((kind) => invoice.actions.payment_limits[kind]?.amount_minor ?? ''),
      ].join(':')
    : '';
  const paymentForm = useForm<BillingInvoicePaymentFormValues>({
    resolver: zodResolver(BillingInvoicePaymentFormSchema),
    defaultValues: {
      kind: initialPaymentKind,
      amountMinor: '',
      currency: invoiceCurrency,
      idempotencyKey: crypto.randomUUID(),
      reference: '',
      occurredAt: nowForInput(),
    },
  });

  useEffect(() => {
    if (!invoiceId) return;
    setVoidReason('');
    setShowVoid(false);
    setShowPayment(false);
    setShowIssueConfirm(false);
    setDownloadError(null);
    resetIssue();
    resetVoid();
    resetPayment();
    paymentForm.reset({
      kind: initialPaymentKind,
      amountMinor: '',
      currency: invoiceCurrency,
      idempotencyKey: crypto.randomUUID(),
      reference: '',
      occurredAt: nowForInput(),
    });
  }, [
    initialPaymentKind,
    invoiceActionRevision,
    invoiceCurrency,
    invoiceId,
    paymentForm,
    resetIssue,
    resetPayment,
    resetVoid,
  ]);

  if (!invoice) return null;
  const currentInvoice = invoice;

  async function downloadPdf() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await billingContractAdminService.downloadInvoicePdf(currentInvoice.id);
      downloadBlob(blob, `${currentInvoice.invoice_number ?? `invoice-${currentInvoice.id}`}.pdf`);
    } catch (error) {
      setDownloadError(error);
    } finally {
      setDownloading(false);
    }
  }

  async function record(values: BillingInvoicePaymentFormValues) {
    const limit = currentInvoice.actions.payment_limits[values.kind];
    if (!limit || BigInt(values.amountMinor) > BigInt(limit.amount_minor)) {
      paymentForm.setError('amountMinor', {
        message: limit
          ? `Amount cannot exceed ${limit.display}.`
          : 'This activity is not available for the invoice.',
      });
      return;
    }
    await recordPayment.mutateAsync({ invoiceId: currentInvoice.id, values });
    setShowPayment(false);
  }

  const allowedPaymentKinds = availablePaymentKinds(currentInvoice);
  const selectedPaymentKind = paymentForm.watch('kind');
  const selectedPaymentLimit = currentInvoice.actions.payment_limits[selectedPaymentKind];

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={invoice.invoice_number ?? `Draft invoice · ${invoice.billing_month}`}
      widthClassName="max-w-4xl"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-gray-50 px-4 py-3">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant={statusVariant(invoice.status)}>{invoice.status}</Badge>
              <Badge variant={invoice.payment_status === 'paid' ? 'green' : 'slate'}>
                {invoice.payment_status.replace('_', ' ')}
              </Badge>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {invoice.buyer.legal_name} · revision {invoice.revision}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Issued {displayUtcDate(invoice.issue_date)} · Due {displayUtcDate(invoice.due_date)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Outstanding</p>
            <p className="text-xl font-semibold text-gray-900">
              {invoice.totals.outstanding.display}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['Subtotal', invoice.totals.subtotal.display],
            ['Tax', invoice.totals.tax.display],
            ['Credits applied', invoice.totals.credits_applied.display],
            ['Paid', invoice.totals.paid.display],
            ['Written off', invoice.totals.written_off.display],
            ['Outstanding', invoice.totals.outstanding.display],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-gray-200 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                {label}
              </p>
              <p className="mt-1 text-sm font-semibold text-gray-900">{value}</p>
            </div>
          ))}
        </div>

        {invoice.status === 'void' ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            <p className="font-semibold">Voided {displayUtcDate(invoice.voided_at)}</p>
            <p className="mt-1">{invoice.void_reason ?? 'No reason was recorded.'}</p>
          </div>
        ) : null}

        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="rounded-xl border border-gray-200 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Issuer</p>
            <p className="mt-2 font-medium text-gray-900">{invoice.issuer.legal_name}</p>
            <p className="text-gray-500">{invoice.issuer.billing_email}</p>
          </div>
          <div className="rounded-xl border border-gray-200 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Buyer</p>
            <p className="mt-2 font-medium text-gray-900">{invoice.buyer.legal_name}</p>
            <p className="text-gray-500">{invoice.buyer.billing_email}</p>
          </div>
        </div>

        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 sm:hidden">
          {invoice.lines.map((line) => (
            <div key={line.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-gray-900">{line.service.name}</p>
                <p className="truncate text-xs text-gray-400">{line.service.identifier}</p>
              </div>
              <p className="shrink-0 font-semibold text-gray-900">{line.price.display}</p>
            </div>
          ))}
          <div className="flex justify-between gap-3 bg-gray-50 px-4 py-3 text-sm font-semibold text-gray-900">
            <span>Invoice total</span>
            <span>{invoice.totals.total.display}</span>
          </div>
        </div>
        <div className="hidden overflow-x-auto rounded-xl border border-gray-200 sm:block">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2.5">Service</th>
                <th className="px-4 py-2.5 text-right">Calculated price</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id} className="border-t border-gray-100">
                  <td className="px-4 py-3">
                    <span className="font-medium text-gray-900">{line.service.name}</span>
                    <span className="ml-2 text-xs text-gray-400">{line.service.identifier}</span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {line.price.display}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-gray-200 bg-gray-50 font-semibold text-gray-900">
              <tr>
                <td className="px-4 py-3">Invoice total</td>
                <td className="px-4 py-3 text-right">{invoice.totals.total.display}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {invoice.separately_billed_add_ons.length > 0 ? (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-sm font-semibold text-blue-900">Collected separately</p>
            {invoice.separately_billed_add_ons.map((addOn) => (
              <p key={addOn.id} className="mt-1 text-sm text-blue-800">
                {addOn.service.name} · {addOn.offer.name} · {addOn.monthly_price.display}
              </p>
            ))}
          </div>
        ) : null}

        {invoice.payments.length > 0 ? (
          <div className="rounded-xl border border-gray-200">
            <div className="border-b border-gray-100 px-4 py-3">
              <p className="text-sm font-semibold text-gray-900">Payment activity</p>
            </div>
            <div className="divide-y divide-gray-100">
              {invoice.payments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium text-gray-900">{paymentKindLabel(payment.kind)}</p>
                    <p className="text-xs text-gray-500">
                      {displayInstant(payment.occurred_at)}
                      {payment.reference ? ` · ${payment.reference}` : ''}
                    </p>
                  </div>
                  <p className="font-semibold text-gray-900">{payment.amount.display}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {invoice.actions.issue ? (
            <Button
              variant="primary"
              disabled={issue.isPending}
              onClick={() => setShowIssueConfirm(true)}
            >
              {invoice.actions.issue === 'resume_issue' ? 'Resume invoice issue' : 'Issue invoice'}
            </Button>
          ) : null}
          {invoice.actions.download_pdf ? (
            <Button disabled={downloading} onClick={downloadPdf}>
              {downloading ? 'Downloading...' : 'Download PDF'}
            </Button>
          ) : null}
          {allowedPaymentKinds.length > 0 ? (
            <Button onClick={() => setShowPayment((value) => !value)}>
              Record payment activity
            </Button>
          ) : null}
          {invoice.actions.void ? (
            <Button variant="danger" onClick={() => setShowVoid((value) => !value)}>
              Void invoice
            </Button>
          ) : null}
        </div>

        {showIssueConfirm ? (
          <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-950">
              {invoice.actions.issue === 'resume_issue'
                ? 'Resume immutable PDF issuance?'
                : 'Issue this legal invoice?'}
            </p>
            <p className="text-xs text-amber-900">
              {invoice.actions.issue === 'resume_issue'
                ? 'UOA will resume the previously allocated invoice number and verify the immutable PDF.'
                : 'UOA will allocate the next invoice number and store an immutable PDF. This cannot be undone; an issued invoice can only be voided when UOA permits it.'}
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setShowIssueConfirm(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={issue.isPending}
                onClick={() => issue.mutate(invoice.id)}
              >
                {issue.isPending ? 'Issuing...' : 'Confirm issue'}
              </Button>
            </div>
          </div>
        ) : null}

        {showPayment ? (
          <form
            className="space-y-3 rounded-xl border border-gray-200 p-4"
            onSubmit={paymentForm.handleSubmit(record)}
          >
            <input type="hidden" {...paymentForm.register('idempotencyKey')} />
            <input type="hidden" {...paymentForm.register('currency')} />
            <div className="grid gap-3 sm:grid-cols-3">
              <FieldShell label="Activity">
                <SelectField className="w-full" {...paymentForm.register('kind')}>
                  {allowedPaymentKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {paymentKindLabel(kind)}
                    </option>
                  ))}
                </SelectField>
              </FieldShell>
              <FieldShell
                label="Amount (minor units)"
                hint={selectedPaymentLimit ? `Maximum ${selectedPaymentLimit.display}.` : undefined}
                error={paymentForm.formState.errors.amountMinor?.message}
              >
                <TextField
                  {...paymentForm.register('amountMinor')}
                  inputMode="numeric"
                  max={selectedPaymentLimit?.amount_minor}
                />
              </FieldShell>
              <FieldShell label="Currency">
                <div className="flex h-9 items-center rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm font-medium text-gray-700">
                  {selectedPaymentLimit?.currency ?? invoice.currency}
                </div>
              </FieldShell>
              <FieldShell
                label="Occurred at"
                error={paymentForm.formState.errors.occurredAt?.message}
              >
                <TextField
                  {...paymentForm.register('occurredAt')}
                  type="datetime-local"
                  max={nowForInput()}
                />
              </FieldShell>
              <FieldShell label="Reference" error={paymentForm.formState.errors.reference?.message}>
                <TextField
                  {...paymentForm.register('reference')}
                  placeholder="Bank transfer reference"
                />
              </FieldShell>
            </div>
            <Button type="submit" variant="primary" disabled={recordPayment.isPending}>
              {recordPayment.isPending ? 'Recording...' : 'Record activity'}
            </Button>
            <ActionError value={recordPayment.error} />
          </form>
        ) : null}

        {showVoid ? (
          <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <FieldShell label="Reason for voiding">
              <TextAreaField
                rows={3}
                maxLength={500}
                value={voidReason}
                onChange={(event) => setVoidReason(event.target.value)}
              />
            </FieldShell>
            <Button
              variant="danger"
              disabled={voidInvoice.isPending || !voidReason.trim()}
              onClick={() =>
                voidInvoice.mutate({ invoiceId: invoice.id, reason: voidReason.trim() })
              }
            >
              {voidInvoice.isPending ? 'Voiding...' : 'Confirm void'}
            </Button>
            <ActionError value={voidInvoice.error} />
          </div>
        ) : null}

        <ActionError value={issue.error} />
        <ActionError value={downloadError} />
      </div>
    </Modal>
  );
}
