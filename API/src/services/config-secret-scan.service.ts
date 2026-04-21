export function containsSecretValue(value: unknown, secret: string): boolean {
  // Keep this conservative and cheap: we only scan for string matches.
  // The secret should never appear anywhere in user-controlled config payloads.
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();

  while (stack.length) {
    const current = stack.pop();
    if (current == null) continue;

    if (typeof current === 'string') {
      if (current === secret) return true;
      if (secret.length >= 8 && current.includes(secret)) return true;
      continue;
    }

    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    for (const v of Object.values(current as Record<string, unknown>)) {
      stack.push(v);
    }
  }

  return false;
}
