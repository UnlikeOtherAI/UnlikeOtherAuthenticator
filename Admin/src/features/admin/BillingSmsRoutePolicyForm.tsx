import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button } from '../../components/ui/Button';
import { FieldShell, SelectField, TextAreaField, TextField } from '../../components/ui/FormFields';
import { SmsRouteImportSchema, type SmsRouteImport } from '../../schemas/billing-sms-policies';

export function BillingSmsRoutePolicyForm({ pending, error, onPreview }: {
  pending: boolean; error: boolean; onPreview: (input: SmsRouteImport) => void;
}) {
  const form = useForm<SmsRouteImport>({ resolver: zodResolver(SmsRouteImportSchema),
    defaultValues: { account_sid: '', country: '', direction: 'outbound', currency: 'USD',
      additional_per_segment: '', additional_per_message: '', source: '', evidence: '', expires_at: '' } });
  return <form className="space-y-4" onSubmit={form.handleSubmit(onPreview)}>
    <div className="grid gap-4 sm:grid-cols-2">
      <FieldShell label="Provider account SID" error={form.formState.errors.account_sid?.message}>
        <TextField {...form.register('account_sid')} placeholder="AC…" /></FieldShell>
      <FieldShell label="Country" error={form.formState.errors.country?.message}>
        <TextField {...form.register('country')} placeholder="GB" maxLength={2} /></FieldShell>
      <FieldShell label="Direction"><SelectField {...form.register('direction')} className="w-full">
        <option value="outbound">Outbound</option><option value="inbound">Inbound</option>
      </SelectField></FieldShell>
      <FieldShell label="Provider currency"><SelectField {...form.register('currency')} className="w-full">
        <option value="USD">USD</option><option value="EUR">EUR</option></SelectField></FieldShell>
      <FieldShell label="Additional charge per segment" error={form.formState.errors.additional_per_segment?.message}
        hint="Conservative maximum in the provider currency, including carrier fees.">
        <TextField {...form.register('additional_per_segment')} placeholder="0.003" /></FieldShell>
      <FieldShell label="Additional charge per message" error={form.formState.errors.additional_per_message?.message}
        hint="Conservative maximum including processing and failure charges.">
        <TextField {...form.register('additional_per_message')} placeholder="0.001" /></FieldShell>
    </div>
    <FieldShell label="Evidence source" error={form.formState.errors.source?.message}
      hint="Document URL or immutable internal evidence reference, with account-specific applicability.">
      <TextField {...form.register('source')} maxLength={500} /></FieldShell>
    <FieldShell label="Documented fee evidence" error={form.formState.errors.evidence?.message}
      hint="Paste the relevant fee terms and explain why both bounds cover this route. Missing Pricing API evidence never proves zero fees. Preserve the original source document in the operator evidence archive.">
      <TextAreaField {...form.register('evidence')} rows={5} maxLength={32_000} /></FieldShell>
    <FieldShell label="Valid until" error={form.formState.errors.expires_at?.message}
      hint="Source-supported UTC or offset timestamp; for example 2026-11-01T00:00:00Z.">
      <TextField {...form.register('expires_at')} placeholder="2026-11-01T00:00:00Z" /></FieldShell>
    {error ? <p role="alert" className="text-sm text-red-600">Could not preview route evidence. Check the dimensions, source and expiry, then retry.</p> : null}
    <Button type="submit" disabled={pending}>{pending ? 'Validating...' : 'Review route policy'}</Button>
  </form>;
}
