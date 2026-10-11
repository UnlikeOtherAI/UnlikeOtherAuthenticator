import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { SmsCountryPreview } from '../../schemas/billing-sms-policies';
import { smsCountryName } from './sms-countries';

/** The one Add country screen: both directions' account prices and bounds, then one Accept. */
export function BillingSmsCountryReview({ preview, pending, error, onClose, onAccept }: {
  preview: SmsCountryPreview | null; pending: boolean; error: boolean; onClose: () => void; onAccept: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer); }, []);
  const evidence = preview?.evidence;
  const expired = !preview || Date.parse(preview.preview_expires_at) <= now;
  return <Modal isOpen={Boolean(preview)} onClose={onClose} isPending={pending} widthClassName="max-w-2xl"
    title={evidence ? `Add ${smsCountryName(evidence.country)} (${evidence.country})` : 'Add country'}
    footer={<Button variant="primary" disabled={pending || expired} onClick={onAccept}>
      {pending ? 'Accepting...' : 'Accept'}</Button>}>
    {preview && evidence ? <div className="space-y-4 text-sm">
      <dl className="grid gap-1 sm:grid-cols-[8rem_1fr]">
        <dt className="text-gray-500">Account</dt><dd className="break-all font-mono text-xs text-gray-900">{evidence.account_sid}</dd>
        <dt className="text-gray-500">Validity</dt><dd className="text-gray-900">{evidence.validity_days} days, until {new Date(evidence.routes[0].expires_at).toLocaleString()}</dd>
        <dt className="text-gray-500">Bound rule</dt><dd className="font-mono text-xs text-gray-900">{evidence.rule}</dd>
      </dl>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="text-xs text-gray-500"><tr><th className="py-1 pr-3 font-medium">Direction</th>
          <th className="py-1 pr-3 font-medium">Account price</th><th className="py-1 pr-3 font-medium">Bound per segment</th>
          <th className="py-1 font-medium">Bound per message</th></tr></thead>
        <tbody>{evidence.routes.map((route) => <tr key={route.direction} className="border-t border-gray-100">
          <td className="py-2 pr-3 capitalize text-gray-900">{route.direction}</td>
          <td className="py-2 pr-3 font-mono text-xs">{route.currency} {route.provider_price}</td>
          <td className="py-2 pr-3 font-mono text-xs">{route.currency} {route.additional_per_segment}</td>
          <td className="py-2 font-mono text-xs">{route.currency} {route.additional_per_message}</td></tr>)}</tbody>
      </table></div>
      <p className="text-xs text-gray-500">Account price is the configured Twilio account's own current price per
        segment. Bounds are added to it in every quote; settlement still uses the actual charge.</p>
      <p className="text-gray-700">Accept records, under your UOA subject, that you understand this policy, that each
        per-segment bound covers all applicable carrier and route charges, and that each per-message bound covers
        processing and failure charges.</p>
      <details><summary className="cursor-pointer text-blue-600">Generated evidence</summary>
        {preview.evidence_documents.map((document, index) => <p key={evidence.routes[index]?.direction}
          className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{document}</p>)}
      </details>
      {expired ? <p role="alert" className="text-red-600">This review expired. Close it and add the country again.</p> : null}
      {error ? <p role="alert" className="text-red-600">Acceptance failed. Check accepted history before retrying; a lost response may already have committed.</p> : null}
    </div> : null}
  </Modal>;
}
