import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { FieldShell, TextAreaField } from '../../components/ui/FormFields';
import { Badge } from '../../components/ui/Badge';
import { billingSmsPolicyService as service } from '../../services/billing-sms-policy-service';
import type { SmsFxPreview, SmsRoutePreview } from '../../schemas/billing-sms-policies';
import { BillingSmsPolicyReview } from './BillingSmsPolicyReview';
import { BillingSmsRoutePolicyForm } from './BillingSmsRoutePolicyForm';
import { BillingSmsRecoveryPanel } from './BillingSmsRecoveryPanel';
import { BillingSmsLiabilityPanel } from './BillingSmsLiabilityPanel';

const queryKey = ['admin', 'billing', 'sms-policies'];
export function BillingSmsPoliciesPanel() {
  const client = useQueryClient();
  const policies = useQuery({ queryKey, queryFn: service.list });
  const [xml, setXml] = useState('');
  const [fx, setFx] = useState<SmsFxPreview | null>(null);
  const [route, setRoute] = useState<SmsRoutePreview | null>(null);
  const refresh = useMutation({ mutationFn: service.previewFx,
    onSuccess: (result) => { acceptFx.reset(); setFx(result); } });
  const importRoute = useMutation({ mutationFn: service.previewRoute,
    onSuccess: (result) => { acceptRoute.reset(); setRoute(result); } });
  const acceptFx = useMutation({ mutationFn: async (reason: string) => {
    if (!fx) throw new Error('Preview required'); return service.acceptFx(fx.preview_token, reason);
  }, onSuccess: async () => { setFx(null); await client.invalidateQueries({ queryKey }); } });
  const acceptRoute = useMutation({ mutationFn: async (reason: string) => {
    if (!route) throw new Error('Preview required'); return service.acceptRoute(route.preview_token, reason);
  }, onSuccess: async () => { setRoute(null); await client.invalidateQueries({ queryKey }); } });
  return <div className="space-y-4">
    <Card className="p-5"><CardHeader><h2 className="font-semibold text-gray-900">SMS pricing policies</h2></CardHeader>
      <p className="text-sm text-gray-600">Private operator evidence for mobile-number pricing and prepaid SMS.
        Accepted policies apply only while fresh. A missing or expired policy blocks new quotes or dispatch.
        Customers receive final prices only. These controls do not enable billing or provision provider credentials.</p>
    </Card>
    <Card className="space-y-4 p-5"><h3 className="font-semibold text-gray-900">Dated ECB reference rate</h3>
      <p className="text-sm text-gray-500">Refresh the fixed ECB daily USD-per-EUR document, or import that source's XML.
        Review its date, hash and expiry before explicitly accepting commercial use. Reimporting cannot extend the source date's seven-day validity.</p>
      <Button disabled={refresh.isPending} onClick={() => refresh.mutate(undefined)}>
        {refresh.isPending ? 'Fetching evidence...' : 'Refresh ECB evidence'}</Button>
      <details><summary className="cursor-pointer text-sm text-blue-600">Import ECB daily XML</summary>
        <div className="mt-3 space-y-3"><FieldShell label="ECB daily XML">
          <TextAreaField value={xml} onChange={(event) => setXml(event.target.value)} maxLength={100_000} rows={5} />
        </FieldShell><Button disabled={!xml.trim() || refresh.isPending} onClick={() => refresh.mutate(xml)}>
          Review imported ECB evidence</Button></div></details>
      {refresh.isError ? <p role="alert" className="text-sm text-red-600">Could not validate fresh ECB evidence. Retry refresh or import a current source document.</p> : null}
    </Card>
    <Card className="space-y-4 p-5"><h3 className="font-semibold text-gray-900">Account-specific route fee bounds</h3>
      <p className="text-sm text-gray-500">Import reviewed documentation for the exact route. Provide both additional
        per-segment and per-message bounds; zero requires explicit supporting evidence. The server hashes the complete import.</p>
      <BillingSmsRoutePolicyForm pending={importRoute.isPending} error={importRoute.isError}
        onPreview={(input) => importRoute.mutate(input)} />
    </Card>
    <Card className="space-y-4 p-5"><div className="flex items-center justify-between"><h3 className="font-semibold text-gray-900">Accepted evidence history</h3>
      <Button onClick={() => void policies.refetch()}>Reload history</Button></div>
      {policies.isLoading ? <p className="text-sm text-gray-500">Loading accepted policies...</p> : null}
      {policies.isError ? <p role="alert" className="text-sm text-red-600">Could not load accepted policies. Reload history to retry.</p> : null}
      {policies.data ? <>
        <p className="text-xs text-gray-500">Latest 50 currency policies and 100 route policies; immutable acceptance records.</p>
        {policies.data.fx.map((value) => <div key={value.id} className="rounded-lg border border-gray-200 p-3 text-sm">
          <PolicyStatus expiresAt={value.expires_at} /> <strong>ECB · {value.rate_date} · USD/EUR {value.usd_per_eur}</strong>
          <EvidenceRecord source={value.source} digest={value.source_digest} expiresAt={value.expires_at}
            acceptedAt={value.accepted_at} actor={value.accepted_by_user_id} reason={value.acceptance_reason} />
        </div>)}
        {policies.data.routes.map((value) => <div key={value.id} className="rounded-lg border border-gray-200 p-3 text-sm">
          <PolicyStatus expiresAt={value.expires_at} /> <strong>{value.country} · {value.direction} · {value.currency}</strong>
          <p className="mt-1 break-all font-mono text-xs">{value.account_sid} · segment {value.additional_per_segment} · message {value.additional_per_message}</p>
          <EvidenceRecord source={value.source} digest={value.evidence_digest} expiresAt={value.expires_at}
            acceptedAt={value.accepted_at} actor={value.accepted_by_user_id} reason={value.acceptance_reason} />
        </div>)}
        {policies.data.fx.length === 0 && policies.data.routes.length === 0 ? <p className="text-sm text-gray-500">No accepted SMS policies.</p> : null}
      </> : null}
    </Card>
    <BillingSmsRecoveryPanel />
    <BillingSmsLiabilityPanel />
    <BillingSmsPolicyReview kind="fx" preview={fx} pending={acceptFx.isPending} error={acceptFx.isError}
      onClose={() => setFx(null)} onAccept={(reason) => acceptFx.mutate(reason)} />
    <BillingSmsPolicyReview kind="route" preview={route} pending={acceptRoute.isPending} error={acceptRoute.isError}
      onClose={() => setRoute(null)} onAccept={(reason) => acceptRoute.mutate(reason)} />
  </div>;
}
function PolicyStatus({ expiresAt }: { expiresAt: string }) {
  const expired = Date.parse(expiresAt) <= Date.now();
  return <Badge variant={expired ? 'red' : 'green'}>{expired ? 'Expired' : 'Fresh'}</Badge>;
}
function EvidenceRecord({ source, digest, expiresAt, acceptedAt, actor, reason }: {
  source: string; digest: string; expiresAt: string; acceptedAt: string; actor: string; reason: string;
}) {
  return <div className="mt-2 space-y-1 break-all text-xs text-gray-500"><p>{source}</p>
    <p className="font-mono">SHA-256 {digest}</p><p>Valid until {new Date(expiresAt).toLocaleString()}</p>
    <p>Accepted {new Date(acceptedAt).toLocaleString()} by {actor}</p><p>{reason}</p></div>;
}
