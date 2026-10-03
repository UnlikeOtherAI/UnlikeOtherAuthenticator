// Preprocessor for boolean env flags: "true"/"1" and "false"/"0"/"" (case- and
// whitespace-insensitive); anything else is left for z.boolean() to reject.
export function normalizeBoolean(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const normalized = input.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0' || normalized === '') return false;
  return input;
}
