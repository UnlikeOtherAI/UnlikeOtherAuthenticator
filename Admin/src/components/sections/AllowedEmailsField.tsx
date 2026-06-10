import { StringListField } from './StringListField';

function normalizeEntry(raw: string): string {
  return raw.trim().toLowerCase();
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

/**
 * Controlled editor for exact allowed-login-email entries. Thin adapter over the shared
 * {@link StringListField} with email-shape validation.
 */
export function AllowedEmailsField({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <StringListField
      value={value}
      onChange={onChange}
      disabled={disabled}
      tone="emerald"
      placeholder="person@acme.com — press Enter to add"
      emptyLabel="No individual email entries."
      normalize={normalizeEntry}
      validate={looksLikeEmail}
    />
  );
}
