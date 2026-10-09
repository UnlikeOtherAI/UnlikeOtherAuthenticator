import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FieldShell, TextAreaField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import type { SmsFxPreview, SmsRoutePreview } from '../../schemas/billing-sms-policies';

export function BillingSmsPolicyReview({ preview, kind, pending, error, onClose, onAccept }: {
  preview: SmsFxPreview | SmsRoutePreview | null; kind: 'fx' | 'route'; pending: boolean;
  error: boolean; onClose: () => void; onAccept: (reason: string) => void;
}) {
  const [reason, setReason] = useState(''); const [understood, setUnderstood] = useState(false);
  const [segments, setSegments] = useState(false); const [messages, setMessages] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setReason(''); setUnderstood(false); setSegments(false); setMessages(false); }, [preview]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer); }, []);
  const expired = !preview || Date.parse(preview.preview_expires_at) <= now ||
    Date.parse(preview.evidence.expires_at) <= now;
  return <Modal isOpen={Boolean(preview)} onClose={onClose} isPending={pending}
    title={kind === 'fx' ? 'Review ECB reference conversion' : 'Review SMS route fee bounds'}
    widthClassName="max-w-2xl" footer={<Button variant="primary" disabled={pending || expired ||
      reason.trim().length < 8 || !understood || (kind === 'route' && (!segments || !messages))}
      onClick={() => onAccept(reason.trim())}>{pending ? 'Accepting...' : 'Accept immutable policy'}</Button>}>
    {preview ? <div className="space-y-4">
      <dl className="space-y-2 text-sm">{Object.entries(preview.evidence).map(([label, value]) =>
        <div key={label} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-500">{label.replaceAll('_', ' ')}</dt>
          <dd className="break-all font-mono text-xs text-gray-900">{value}</dd>
        </div>)}</dl>
      <p className="text-xs text-gray-500">Review expires {new Date(preview.preview_expires_at).toLocaleString()}.
        Acceptance records your UOA subject, time and reason. Existing evidence cannot be edited.</p>
      <label className="flex items-start gap-2 text-sm text-gray-700"><input type="checkbox"
        checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
        {kind === 'fx' ? 'I accept the dated ECB informational reference rate as the commercial USD-per-EUR conversion policy. It is not an executable bank rate.'
          : 'I verified the exact account, country, direction, currency, expiry and documented evidence for this policy.'}</label>
      {kind === 'route' ? <>
        <label className="flex items-start gap-2 text-sm text-gray-700"><input type="checkbox"
          checked={segments} onChange={(event) => setSegments(event.target.checked)} />
          The per-segment bound covers all applicable additional carrier and route charges.</label>
        <label className="flex items-start gap-2 text-sm text-gray-700"><input type="checkbox"
          checked={messages} onChange={(event) => setMessages(event.target.checked)} />
          The per-message bound covers processing and failure charges. Any zero bound is explicitly supported by the evidence.</label>
      </> : null}
      {'evidence_document' in preview ? <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-700">
        <p className="mb-2 font-semibold">Documented fee evidence</p>
        <p className="whitespace-pre-wrap break-words">{preview.evidence_document}</p>
      </div> : null}
      <FieldShell label="Acceptance reason" hint="Record why this source and its bounded validity are suitable.">
        <TextAreaField value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} />
      </FieldShell>
      {expired ? <p role="alert" className="text-sm text-red-600">This review expired. Close and preview fresh evidence.</p> : null}
      {error ? <p role="alert" className="text-sm text-red-600">Acceptance failed. Check accepted history before retrying; a lost response may already have committed.</p> : null}
    </div> : null}
  </Modal>;
}
