/**
 * Pure helpers behind `/components/ui/CodeInput.tsx` (Phase 3c). Kept outside the component so
 * the sanitization behaviour — numeric-only, capped to `length` — is unit-testable without a DOM.
 */

/** Strips everything but digits and caps the result to `length` (paste-safe: `onChange` already
 * receives the full pasted string, so no separate paste handler is needed). */
export function sanitizeCodeValue(raw: string, length: number): string {
  return raw.replace(/[^0-9]/g, '').slice(0, length);
}

/** Sequential-digit placeholder ("123456" for length 6, "12345678" for length 8, ...). */
export function codePlaceholder(length: number): string {
  return Array.from({ length }, (_, i) => ((i % 9) + 1)).join('');
}
