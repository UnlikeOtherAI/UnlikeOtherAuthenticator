import React from 'react';

import { Input } from '../ui/Input.js';

export function TwoFactorInput(props: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  digits?: 6 | 8;
  disabled?: boolean;
}): React.JSX.Element {
  const { label = 'Verification code', digits = 6 } = props;

  return (
    <Input
      name="code"
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder={digits === 8 ? '12345678' : '123456'}
      required
      disabled={props.disabled}
      maxLength={digits}
      label={label}
      value={props.value}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        const next = raw.replace(/[^0-9]/g, '').slice(0, digits);
        props.onChange(next);
      }}
    />
  );
}
