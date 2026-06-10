import { StringListField } from './StringListField';

function normalizeEntry(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
}

/**
 * Controlled editor for an allowed-login-email-domains list. Thin adapter over the shared
 * {@link StringListField}; empty list means "no restriction".
 */
export function AllowedEmailDomainsField({
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
      tone="indigo"
      placeholder="acme.com — press Enter to add"
      emptyLabel="No domain entries."
      normalize={normalizeEntry}
    />
  );
}
