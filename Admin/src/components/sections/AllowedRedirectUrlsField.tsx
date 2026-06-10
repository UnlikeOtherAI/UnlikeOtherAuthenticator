import { StringListField } from './StringListField';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DANGEROUS_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'filesystem:',
]);

// Mirrors the server's redirect-URL policy (API `tryParseRedirectUrl`, RFC 8252): https
// anywhere, http loopback-only, and native custom-scheme deep links. Kept in sync so the
// admin never adds an entry the server would reject at enforcement time.
function isAcceptableRedirectUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return Boolean(url.hostname);
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  if (DANGEROUS_SCHEMES.has(url.protocol)) return false;
  return url.protocol.length > 1 && value.includes('://') && value.length > url.protocol.length + 3;
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
      placeholder="https://app.acme.com/callback or com.acme.app://callback — press Enter to add"
      emptyLabel="No redirect URL entries."
      validate={isAcceptableRedirectUrl}
    />
  );
}
