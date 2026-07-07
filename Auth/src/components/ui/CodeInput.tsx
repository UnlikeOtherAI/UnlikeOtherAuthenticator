import React from 'react';

import { Input } from './Input.js';
import { codePlaceholder, sanitizeCodeValue } from '../../utils/code-input.js';

/**
 * Reusable numeric code entry primitive (Phase 3c), extracted from `form/TwoFactorInput.tsx` so
 * the email-code entry step (`CodeEntryPage`) and 2FA verification share one implementation.
 * Digit-only, capped to `length`, theme-driven via the shared `Input` primitive.
 */
export function CodeInput(props: {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  disabled?: boolean;
  label?: string;
  autoFocus?: boolean;
}): React.JSX.Element {
  const { length = 6, label = 'Verification code' } = props;

  return (
    <Input
      name="code"
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder={codePlaceholder(length)}
      required
      disabled={props.disabled}
      maxLength={length}
      autoFocus={props.autoFocus}
      label={label}
      value={props.value}
      onChange={(e) => props.onChange(sanitizeCodeValue(e.currentTarget.value, length))}
    />
  );
}
