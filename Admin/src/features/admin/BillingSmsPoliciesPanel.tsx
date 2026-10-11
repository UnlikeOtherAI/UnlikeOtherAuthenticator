import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, CardHeader } from '../../components/ui/Card';
import { billingSmsPolicyService as service } from '../../services/billing-sms-policy-service';
import type { SmsFxPreview, SmsRoutePreview } from '../../schemas/billing-sms-policies';
import { BillingSmsAddCountry } from './BillingSmsAddCountry';
import { BillingSmsFxCard } from './BillingSmsFxCard';
import { BillingSmsPolicyAlerts, BillingSmsPolicyHistory } from './BillingSmsPolicyHistory';
import { BillingSmsPolicyReview } from './BillingSmsPolicyReview';
import { BillingSmsRoutePolicyForm } from './BillingSmsRoutePolicyForm';
import { BillingSmsRecoveryPanel } from './BillingSmsRecoveryPanel';
import { BillingSmsLiabilityPanel } from './BillingSmsLiabilityPanel';

const queryKey = ['admin', 'billing', 'sms-policies'];
export function BillingSmsPoliciesPanel() {
  const client = useQueryClient();
  const policies = useQuery({ queryKey, queryFn: service.list });
  const reload = () => client.invalidateQueries({ queryKey });
  const [fx, setFx] = useState<SmsFxPreview | null>(null);
  const [route, setRoute] = useState<SmsRoutePreview | null>(null);
  const importRoute = useMutation({ mutationFn: service.previewRoute,
    onSuccess: (result) => { acceptRoute.reset(); setRoute(result); } });
  const acceptFx = useMutation({ mutationFn: async (reason: string) => {
    if (!fx) throw new Error('Preview required'); return service.acceptFx(fx.preview_token, reason);
  }, onSuccess: async () => { setFx(null); await reload(); } });
  const acceptRoute = useMutation({ mutationFn: async (reason: string) => {
    if (!route) throw new Error('Preview required'); return service.acceptRoute(route.preview_token, reason);
  }, onSuccess: async () => { setRoute(null); await reload(); } });
  return <div className="space-y-4">
    <Card className="p-5"><CardHeader><h2 className="font-semibold text-gray-900">SMS pricing policies</h2></CardHeader>
      <p className="text-sm text-gray-600">Private operator evidence for mobile-number pricing and prepaid SMS.
        Accepted policies apply only while fresh. A missing or expired policy blocks new quotes or dispatch.
        Customers receive final prices only. These controls do not enable billing or provision provider credentials.
        When automatic renewal is enabled, a daily job renews in-band ECB rates and unchanged route prices and raises
        anything else here.</p>
    </Card>
    <BillingSmsPolicyAlerts alerts={policies.data?.alerts ?? []} />
    <BillingSmsFxCard onAccepted={reload} onReview={(result) => { acceptFx.reset(); setFx(result); }} />
    <Card className="space-y-4 p-5"><h3 className="font-semibold text-gray-900">Account-specific route fee bounds</h3>
      <p className="text-sm text-gray-500">Add country reads the configured Twilio account's own mobile prices for
        outbound and inbound, applies the documented bound rule and shows one review to accept. Accepted countries
        renew automatically while their price does not rise, once automatic renewal is enabled.</p>
      <BillingSmsAddCountry onAccepted={reload} />
      <details><summary className="cursor-pointer text-sm text-blue-600">Enter evidence manually</summary>
        <div className="mt-3 space-y-4">
          <p className="text-sm text-gray-500">For routes the Pricing API cannot price. Import reviewed documentation for
            the exact route and provide both additional per-segment and per-message bounds; zero requires explicit
            supporting evidence. The server hashes the complete import. Manual evidence keeps the expiry you enter and
            never renews automatically.</p>
          <BillingSmsRoutePolicyForm pending={importRoute.isPending} error={importRoute.isError}
            onPreview={(input) => importRoute.mutate(input)} />
        </div></details>
    </Card>
    <BillingSmsPolicyHistory data={policies.data} loading={policies.isLoading} failed={policies.isError}
      onReload={() => void policies.refetch()} />
    <BillingSmsRecoveryPanel />
    <BillingSmsLiabilityPanel />
    <BillingSmsPolicyReview kind="fx" preview={fx} pending={acceptFx.isPending} error={acceptFx.isError}
      onClose={() => setFx(null)} onAccept={(reason) => acceptFx.mutate(reason)} />
    <BillingSmsPolicyReview kind="route" preview={route} pending={acceptRoute.isPending} error={acceptRoute.isError}
      onClose={() => setRoute(null)} onAccept={(reason) => acceptRoute.mutate(reason)} />
  </div>;
}
