import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { FieldShell, TextAreaField, TextField } from '../../components/ui/FormFields';
import { Modal } from '../../components/ui/Modal';
import type { BillingCreditGrantResult, BillingOrganisationCreditGrants } from '../../schemas/billing-credit-grants';
import { ApiRequestError } from '../../services/api-client';
import { beginAdminSystemSignIn } from '../auth/admin-oauth';
import { useGrantBillingCreditsMutation } from './billing-credit-grant-queries';
import {
  creditGrantCredits, creditGrantInputMicrocredits, creditGrantUsd, newCreditGrantKey,
} from './billing-credit-grant-format';

const refusals: Record<string, string> = {
  BILLING_CREDIT_GRANT_FRESH_SESSION_REQUIRED:
    'Granting credits needs a session from the last five minutes. Sign in again, then grant.',
  BILLING_CREDIT_GRANT_KEY_CONFLICT:
    'A grant was already recorded for this attempt with different terms. Close this dialog and check the grants list before trying again.',
  BILLING_ORGANISATION_MODE_CHANGED:
    'The organisation’s billing mode changed while you were granting. Close this dialog and start again.',
  BILLING_ADMIN_AUTHORITY_REQUIRED: 'Only a current platform superuser can grant credits.',
};

function refusal(error: unknown): { message: string; signIn: boolean } {
  if (error instanceof ApiRequestError) {
    const code = error.code ?? '';
    return { message: refusals[code] ?? `The grant was refused (${code || `HTTP ${error.status}`}).`,
      signIn: code === 'BILLING_CREDIT_GRANT_FRESH_SESSION_REQUIRED' };
  }
  return { message: 'The grant could not be recorded. Nothing was charged.', signIn: false };
}

/** Grant prepaid credits to one organisation's wallet: amount, reason, a plain statement of the effect. */
export function BillingCreditGrantDialog({
  data, onClose, open,
}: {
  data: BillingOrganisationCreditGrants;
  onClose: () => void;
  open: boolean;
}) {
  const grant = useGrantBillingCreditsMutation(data.organisation.id);
  const [credits, setCredits] = useState('');
  const [reason, setReason] = useState('');
  const [attemptKey, setAttemptKey] = useState(newCreditGrantKey);
  const [result, setResult] = useState<BillingCreditGrantResult | null>(null);
  const { reset } = grant;

  useEffect(() => {
    if (!open) return;
    setCredits('');
    setReason('');
    setResult(null);
    setAttemptKey(newCreditGrantKey());
    reset();
  }, [open, reset]);

  const micro = creditGrantInputMicrocredits(credits, data.limits.max_credits);
  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= data.limits.reason_min && trimmed.length <= data.limits.reason_max;
  const amount = micro === null ? null : { microcredits: micro.toString() };
  const after = micro === null ? null
    : { microcredits: (BigInt(data.balance.confirmed.microcredits) + micro).toString() };
  const modeLabel = data.mode === 'live' ? 'live billing' : 'sandbox billing';
  const failure = grant.isError ? refusal(grant.error) : null;

  async function submit() {
    if (micro === null || !reasonValid) return;
    try {
      setResult(await grant.mutateAsync({ credits: credits.trim(), reason: trimmed, idempotencyKey: attemptKey }));
    } catch {
      /* Keep the values and the same key so a retry cannot grant twice. */
    }
  }

  if (result) {
    return (
      <Modal isOpen={open} onClose={onClose} title={`Credits granted · ${data.organisation.name}`}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="space-y-3 text-sm text-gray-700">
          <p role="status">
            {result.replayed ? 'This grant was already recorded. ' : ''}
            {data.organisation.name} received {creditGrantCredits(result.grant.amount)} (
            {creditGrantUsd(result.grant.amount)}).
          </p>
          <p>New balance: <span className="font-semibold text-gray-900">{creditGrantCredits(result.balance_after)}</span>{' '}
            ({creditGrantUsd(result.balance_after)}).</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      isPending={grant.isPending}
      isDirty={credits !== '' || reason !== ''}
      title={`Grant credits · ${data.organisation.name}`}
      footer={
        <Button icon="check" variant="primary" disabled={micro === null || !reasonValid || grant.isPending}
          onClick={() => void submit()}>
          {grant.isPending ? 'Granting...' : 'Grant credits'}
        </Button>
      }
    >
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p className="text-sm text-gray-600">
          Current balance: <span className="font-medium text-gray-900">{creditGrantCredits(data.balance.confirmed)}</span>{' '}
          ({creditGrantUsd(data.balance.confirmed)}), of which {creditGrantCredits(data.balance.spendable)} can be
          spent now.
        </p>
        <FieldShell
          label="Credits to grant"
          hint={`Whole credits, up to ${creditGrantCredits({ microcredits: (BigInt(data.limits.max_credits) * 1_000_000n).toString() })}. 1,000 credits = US$1.`}
          error={credits !== '' && micro === null ? 'Enter a whole number of credits within the limit.' : undefined}
        >
          <TextField inputMode="numeric" value={credits} placeholder="10000"
            onChange={(event) => { setCredits(event.target.value); reset(); }} />
        </FieldShell>
        <FieldShell
          label="Reason"
          hint={`Saved with the grant and shown to other administrators. ${data.limits.reason_min}–${data.limits.reason_max} characters.`}
        >
          <TextAreaField value={reason} rows={3} maxLength={data.limits.reason_max}
            onChange={(event) => { setReason(event.target.value); reset(); }} />
        </FieldShell>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {amount && after ? (
            <p className="mb-1 font-medium">
              {data.organisation.name} gets {creditGrantCredits(amount)} ({creditGrantUsd(amount)}) now, in {modeLabel}.
              Balance goes from {creditGrantCredits(data.balance.confirmed)} to {creditGrantCredits(after)}.
            </p>
          ) : null}
          <p>
            The credits are spendable straight away, like bought credits. No payment, invoice or Stripe record is
            created, and the grant can never be refunded to a card. The customer sees it as credits granted by
            UnlikeOtherAI. This dialog cannot take credits back, and a remaining balance blocks a change of billing
            mode.
          </p>
        </div>
        {failure ? (
          <div role="alert" className="space-y-2 text-sm text-red-600">
            <p>{failure.message}</p>
            {failure.signIn ? (
              <Button size="sm" onClick={() => void beginAdminSystemSignIn(
                `${window.location.pathname}${window.location.search}`)}>Sign in again</Button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
