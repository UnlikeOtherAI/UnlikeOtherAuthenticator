import { StringListField } from './StringListField';

function looksLikeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Controlled editor for a domain's allowed redirect URLs. Thin adapter over the shared
 * {@link StringListField}. Values are trimmed only (not lower-cased) because the server enforces
 * them with a byte-for-byte match against the redirect the client requests.
 */
export function AllowedRedirectUrlsField({
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
      tone="blue"
      placeholder="https://app.acme.com/callback — press Enter to add"
      emptyLabel="No redirect URL entries."
      validate={looksLikeHttpUrl}
    />
  );
}
