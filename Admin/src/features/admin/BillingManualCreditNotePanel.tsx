import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { TextAreaField } from '../../components/ui/FormFields';
import type { BillingInvoice } from '../../schemas/billing-contracts';
import type { BillingManualCreditNote } from '../../schemas/billing-manual-credit-note';
import { billingContractAdminService } from '../../services/billing-contract-admin-service';
import { downloadBlob } from '../../utils/blob-download';
import { billingMoney } from './billing-money';

/** This control lives with the original invoice; UOA decides eligibility and
 * freezes one full-line legal credit note, rather than editing that invoice. */
export function BillingManualCreditNotePanel({ invoice }: { invoice: BillingInvoice }) {
  const [note, setNote] = useState<BillingManualCreditNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [showPrepare, setShowPrepare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void billingContractAdminService.getManualCreditNote(invoice.id)
      .then((value) => { if (active) setNote(value); })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ?
        failure.message : 'Could not load the credit note.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [invoice.id]);
  if (invoice.status !== 'issued' || invoice.lines.length !== 1 ||
    invoice.totals.credits_applied.amount_minor !== '0' ||
    !invoice.payments.some((payment) => payment.kind === 'payment')) return null;

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      setNote(await billingContractAdminService.prepareManualCreditNote(invoice.id, reason));
      setShowPrepare(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not prepare credit note.');
    } finally { setBusy(false); }
  }

  async function issue() {
    if (!note) return;
    setBusy(true);
    setError(null);
    try { setNote(await billingContractAdminService.issueManualCreditNote(note.id)); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not issue credit note.');
    } finally { setBusy(false); }
  }

  async function download() {
    if (!note) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await billingContractAdminService.downloadManualCreditNotePdf(note.id);
      downloadBlob(blob, `${note.number ?? `credit-note-${note.id}`}.pdf`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not download credit note.');
    } finally { setBusy(false); }
  }

  return <section aria-label="Manual invoice credit note"
    className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
    <div>
      <p className="text-sm font-semibold text-amber-950">{
        note ? 'Credit note for this invoice' : 'Cancel this paid invoice'}</p>
      <p className="mt-1 text-xs text-amber-900">
        A separate numbered credit note reverses the exact original charge and tax.
        The original invoice and accepted payment remain in the history. Refunds are recorded separately.
      </p>
    </div>
    {loading ? <p className="text-sm text-amber-900">Checking credit note…</p> : null}
    {note ? <div className="space-y-2 text-sm text-amber-950">
      <p>{note.number ?? 'Credit note pending issue'} · {
        note.status === 'issued' ? 'Issued' : 'Pending issue'} · {
        billingMoney(note.total_credit_minor, note.currency)}</p>
      <p>Reason: {note.reason}</p>
      {note.status !== 'issued' ? <Button disabled={busy} variant="primary" onClick={issue}>
        {busy ? 'Issuing…' : 'Issue legal credit note'}
      </Button> : <Button disabled={busy} onClick={download}>
        Download credit note PDF
      </Button>}
    </div> : !loading && !showPrepare ?
      <Button disabled={busy} onClick={() => setShowPrepare(true)}>Prepare credit note</Button> : null}
    {showPrepare && !note ? <div className="space-y-2">
      <label htmlFor="credit-note-reason" className="text-sm font-medium text-amber-950">
        Cancellation reason
      </label>
      <TextAreaField id="credit-note-reason" value={reason}
        onChange={(event) => setReason(event.target.value)} maxLength={500} />
      <div className="flex gap-2">
        <Button disabled={busy || !reason.trim()} variant="danger" onClick={prepare}>
          {busy ? 'Preparing…' : 'Confirm cancellation'}
        </Button>
        <Button disabled={busy} onClick={() => setShowPrepare(false)}>Back</Button>
      </div>
    </div> : null}
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
  </section>;
}
