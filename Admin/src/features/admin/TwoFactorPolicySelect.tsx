import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { FieldShell, SelectField } from '../../components/ui/FormFields';
import type { OrganisationTwoFaPolicy, TwoFaPolicy } from './types';

type TwoFactorPolicyValue = OrganisationTwoFaPolicy;

export type TwoFactorPolicyOption = {
  value: TwoFactorPolicyValue;
  label: string;
  hint: string;
};

export const DOMAIN_TWOFA_POLICY_OPTIONS: TwoFactorPolicyOption[] = [
  { value: 'off', label: 'Off', hint: 'Do not prompt users for an authenticator code.' },
  { value: 'optional', label: 'Optional', hint: 'Users may enroll, enrolled users must verify at login.' },
  { value: 'required', label: 'Required', hint: 'Users must enroll before a protected login can finish.' },
];

export const ORGANISATION_TWOFA_POLICY_OPTIONS: TwoFactorPolicyOption[] = [
  { value: 'inherit', label: 'Inherit', hint: 'Use the domain policy unless another organisation requires more.' },
  { value: 'optional', label: 'Optional', hint: 'Users may enroll, enrolled users must verify at login.' },
  { value: 'required', label: 'Required', hint: 'Members must enroll before a protected login can finish.' },
];

export function isDomainTwoFaPolicy(value: TwoFactorPolicyValue): value is TwoFaPolicy {
  return value !== 'inherit';
}

export function TwoFactorPolicySelect(props: {
  title: string;
  description: string;
  value: TwoFactorPolicyValue;
  options: TwoFactorPolicyOption[];
  saving?: boolean;
  onSave: (value: TwoFactorPolicyValue) => Promise<unknown>;
}) {
  const [value, setValue] = useState<TwoFactorPolicyValue>(props.value);

  useEffect(() => {
    setValue(props.value);
  }, [props.value]);

  const selected = props.options.find((option) => option.value === value);
  const dirty = value !== props.value;

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{props.title}</h3>
          <p className="mt-0.5 text-xs text-gray-500">{props.description}</p>
        </div>
        <Button
          icon="check"
          variant="primary"
          size="sm"
          disabled={!dirty || props.saving}
          onClick={() => props.onSave(value)}
        >
          {props.saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)]">
        <FieldShell label="Policy">
          <SelectField value={value} onChange={(event) => setValue(event.target.value as TwoFactorPolicyValue)}>
            {props.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        </FieldShell>
        <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-500">
          {selected?.hint}
        </div>
      </div>
    </Card>
  );
}
