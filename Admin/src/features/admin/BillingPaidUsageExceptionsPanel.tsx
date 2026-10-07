import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { FieldShell, TextAreaField } from '../../components/ui/FormFields';
import { createApiClient } from '../../services/api-client';

const api = createApiClient();
const Exception = z.object({
  dispatch_id: z.string(), receipt_id: z.string(),
  status: z.literal('HELD_OPERATOR_RECONCILIATION'),
  evidence_digest: z.string().length(64), product: z.string(),
  raw_cost_actual: z.string(), raw_cost_bound: z.string().nullable(),
  max_collectible_microcredits: z.string().nullable(),
  currency: z.string(), created_at: z.string(),
  gross_rated_microcredits: z.null(), collectible_microcredits: z.null(),
  waived_microcredits: z.null(),
}).strict();
const List = z.object({ exceptions: z.array(Exception), has_more: z.boolean() }).strict();
const Decision = z.object({
  dispatch_id: z.string(), receipt_id: z.string(), status: z.literal('WRITTEN_OFF'),
  evidence_digest: z.string(), gross_rated_microcredits: z.string(),
  collectible_microcredits: z.string(), waived_microcredits: z.string(),
}).strict();

function randomDecisionKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function BillingPaidUsageExceptionsPanel() {
  const key = ['admin', 'billing', 'paid-usage-exceptions'];
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [decisionKey, setDecisionKey] = useState(randomDecisionKey);
  const list = useQuery({ queryKey: key, queryFn: async () => List.parse(
    await api.get<unknown>('/internal/admin/billing/paid-usage-exceptions')) });
  const writeOff = useMutation({
    mutationFn: async (input: { dispatchId: string; digest: string; reason: string }) =>
      Decision.parse(await api.post<unknown>(
        `/internal/admin/billing/paid-usage-exceptions/${encodeURIComponent(input.dispatchId)}/write-off`,
        { evidence_digest: input.digest, idempotency_key: decisionKey,
          reason: input.reason.trim() },
      )),
    onSuccess: async () => {
      setSelected(null);
      setReason('');
      setDecisionKey(randomDecisionKey());
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <Card className="p-5">
      <CardHeader><h2 className="font-semibold text-gray-900">Paid usage exceptions</h2></CardHeader>
      <p className="mb-4 text-sm text-gray-500">
        These provider receipts exceeded the original authorized cost bound. Review the exact
        receipt before closing an exception. UOA charges at most the original credit hold,
        records the excess as an operator waiver, and retains gross usage for credit budgets.
      </p>
      {list.isLoading ? <p className="text-sm text-gray-500">Loading exceptions...</p> : null}
      {list.isError ? <p role="alert" className="text-sm text-red-600">
        Could not load paid usage exceptions.
      </p> : null}
      {list.data?.exceptions.length === 0 ? <p className="text-sm text-gray-500">
        No over-bound paid usage needs a decision.
      </p> : null}
      <div className="space-y-3">
        {list.data?.exceptions.map((item) => (
          <div key={item.dispatch_id} className="rounded-lg border border-gray-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{item.product}</p>
                <p className="break-all text-xs text-gray-500">Dispatch {item.dispatch_id}</p>
                <p className="break-all text-xs text-gray-500">Receipt {item.receipt_id}</p>
                <p className="text-xs text-gray-500">
                  Observed {item.currency} {item.raw_cost_actual}; authorized bound{' '}
                  {item.raw_cost_bound ?? 'unknown'}. Maximum collectible{' '}
                  {item.max_collectible_microcredits ?? 'unknown'} microcredits.
                </p>
              </div>
              <Button onClick={() => {
                setSelected(item.dispatch_id === selected ? null : item.dispatch_id);
                setReason('');
                writeOff.reset();
              }}>{selected === item.dispatch_id ? 'Close review' : 'Review waiver'}</Button>
            </div>
            {selected === item.dispatch_id ? (
              <div className="mt-4 space-y-3 border-t border-gray-200 pt-4">
                <p className="break-all text-xs text-gray-500">
                  Ledger evidence digest: {item.evidence_digest}
                </p>
                <FieldShell label="Operator reason" hint="Record why the excess is waived.">
                  <TextAreaField value={reason} maxLength={500} rows={3}
                    onChange={(event) => setReason(event.target.value)} />
                </FieldShell>
                {writeOff.isError ? <p role="alert" className="text-sm text-red-600">
                  The decision was not saved. Refresh your admin session if it is older than five
                  minutes, then retry with the same receipt.
                </p> : null}
                <Button variant="danger" disabled={reason.trim().length < 12 || writeOff.isPending}
                  onClick={() => writeOff.mutate({ dispatchId: item.dispatch_id,
                    digest: item.evidence_digest, reason })}>
                  {writeOff.isPending ? 'Recording decision...' : 'Cap charge and waive excess'}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {list.data?.has_more ? <p className="mt-4 text-xs text-gray-500">
        Showing the oldest 100 exceptions. Resolve them to reveal more.
      </p> : null}
    </Card>
  );
}
