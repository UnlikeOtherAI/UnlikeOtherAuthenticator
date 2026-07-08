import React from 'react';

import { CodeInput } from '../ui/CodeInput.js';

export function TwoFactorInput(props: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  digits?: 6 | 8;
  disabled?: boolean;
}): React.JSX.Element {
  const { label = 'Verification code', digits = 6 } = props;

  return (
    <CodeInput
      value={props.value}
      onChange={props.onChange}
      length={digits}
      disabled={props.disabled}
      label={label}
    />
  );
}
