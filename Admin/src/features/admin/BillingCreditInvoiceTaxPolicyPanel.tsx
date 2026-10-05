import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { FieldShell, SelectField, TextField } from '../../components/ui/FormFields';
import { createApiClient } from '../../services/api-client';
import { useBillingInvoiceIssuersQuery } from './billing-contract-queries';

const api = createApiClient();
const PolicySchema = z.object({
  id: z.string(),
  account_id: z.string(),
  version: z.number().int(),
  issuer_profile_id: z.string(),
  jurisdiction_country: z.string(),
  treatment: z.enum(['INCLUSIVE_RATE', 'NO_TAX_CHARGED']),
  rate_bps: z.number().int(),
  legal_basis_reference: z.string(),
  effective_from: z.string(),
  created_at: z.string(),
  created_by_email: z.string(),
}).strict();
const ResponseSchema = z.object({
  accounts: z.array(z.object({
    id: z.string(),
    stripe_account_id: z.string(),
    livemode: z.boolean(),
  }).strict()),
  policies: z.array(PolicySchema),
}).strict();
type PolicyInput = {
  account_id: string;
  issuer_profile_id: string;
  jurisdiction_country: string;
  treatment: 'INCLUSIVE_RATE' | 'NO_TAX_CHARGED';
  rate_bps: number;
  legal_basis_reference: string;
  effective_from: string;
};

export function BillingCreditInvoiceTaxPolicyPanel() {
  const issuers = useBillingInvoiceIssuersQuery();
  const queryClient = useQueryClient();
  const queryKey = ['admin', 'billing', 'credit-invoice-tax-policies'];
  const policies = useQuery({
    queryKey,
    queryFn: async () => ResponseSchema.parse(
      await api.get<unknown>('/internal/admin/billing/credit-invoice-tax-policies'),
    ),
  });
  const create = useMutation({
    mutationFn: async (input: PolicyInput) => PolicySchema.parse(
      await api.post<unknown>('/internal/admin/billing/credit-invoice-tax-policies', input),
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      setBasis('');
    },
  });
  const [accountId, setAccountId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [treatment, setTreatment] = useState<PolicyInput['treatment']>('INCLUSIVE_RATE');
  const [rateBps, setRateBps] = useState('');
  const [basis, setBasis] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const issuer = issuers.data?.find((item) => item.id === issuerId);
  const [country, setCountry] = useState('');
  const numericRate = treatment === 'NO_TAX_CHARGED' ? 0 : Number(rateBps);
  const validRate = treatment === 'NO_TAX_CHARGED' ||
    (/^\d+$/.test(rateBps) && Number.isSafeInteger(numericRate) &&
      numericRate >= 1 && numericRate <= 10_000);
  const canSave = Boolean(accountId && issuer && /^[A-Z]{2}$/.test(country) &&
    basis.trim().length >= 8 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(effectiveFrom) &&
    Number.isFinite(Date.parse(effectiveFrom)) && validRate && !create.isPending);

  return (
    <Card className="p-5">
      <CardHeader><h2 className="font-semibold text-gray-900">Prepaid invoice tax policy</h2></CardHeader>
      <p className="mb-4 text-sm text-gray-500">
        An accepted credit purchase stays pending document until its legal issuer, buyer and
        inclusive tax treatment are verified. Policies are versioned and cannot be edited.
      </p>
      {policies.isError || issuers.isError ? (
        <p role="alert" className="mb-3 text-sm text-red-600">
          Could not load invoice tax policies or issuers.
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        <FieldShell label="Stripe account">
          <SelectField value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">Choose account</option>
            {policies.data?.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.stripe_account_id} ({account.livemode ? 'live' : 'test'})
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Legal issuer">
          <SelectField value={issuerId} onChange={(event) => setIssuerId(event.target.value)}>
            <option value="">Choose issuer</option>
            {issuers.data?.filter((item) => item.active).map((item) => (
              <option key={item.id} value={item.id}>{item.legal_name}</option>
            ))}
          </SelectField>
        </FieldShell>
        <FieldShell label="Tax treatment">
          <SelectField
            value={treatment}
            onChange={(event) => setTreatment(event.target.value as PolicyInput['treatment'])}
          >
            <option value="INCLUSIVE_RATE">Inclusive tax rate</option>
            <option value="NO_TAX_CHARGED">No tax charged (documented basis)</option>
          </SelectField>
        </FieldShell>
        {treatment === 'INCLUSIVE_RATE' ? (
          <FieldShell label="Inclusive rate (basis points)" hint="2000 = 20%; tax is within the paid amount">
            <TextField
              inputMode="numeric"
              value={rateBps}
              onChange={(event) => setRateBps(event.target.value)}
            />
          </FieldShell>
        ) : null}
        <FieldShell label="Effective from (UTC)" hint="ISO time, for example 2026-10-04T00:00:00Z">
          <TextField
            type="text"
            placeholder="YYYY-MM-DDTHH:MM:SSZ"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </FieldShell>
    <FieldShell label="Buyer tax jurisdiction" hint="ISO country code for the buyer's applicable tax treatment">
      <TextField value={country} maxLength={2} onChange={(event) =>
        setCountry(event.target.value.toUpperCase())} placeholder="GB" />
        </FieldShell>
      </div>
      <div className="mt-3">
        <FieldShell label="Legal basis reference" hint="Record the approved tax rule, ruling or exemption reference">
          <TextField value={basis} onChange={(event) => setBasis(event.target.value)} />
        </FieldShell>
      </div>
      {create.isError ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          Policy could not be saved. Check the issuer jurisdiction, rate and authority.
        </p>
      ) : null}
      <Button
        className="mt-4"
        disabled={!canSave}
        onClick={() => {
          if (!canSave) return;
          create.mutate({
            account_id: accountId,
            issuer_profile_id: issuerId,
            jurisdiction_country: country,
            treatment,
            rate_bps: numericRate,
            legal_basis_reference: basis.trim(),
            effective_from: effectiveFrom,
          });
        }}
      >
        Add tax policy
      </Button>
      {policies.data?.policies.length ? (
        <div className="mt-5 space-y-2">
          {policies.data.policies.map((policy) => (
            <p key={policy.id} className="text-xs text-gray-600">
              Version {policy.version} · {policy.jurisdiction_country} ·{' '}
              {policy.treatment === 'INCLUSIVE_RATE'
                ? `${policy.rate_bps / 100}% inclusive` : 'No tax charged'} ·{' '}
              from {new Date(policy.effective_from).toLocaleString()} ·{' '}
              {policy.legal_basis_reference}
            </p>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
