const ALLOWED_FONT_IMPORT_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'fonts.bunny.net',
]);

// Mirrors Auth/src/theme/theme-utils.ts so email HTML drops unsafe theme values
// the same way the Auth UI does.
export function sanitizeFontImportUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return undefined;
    if (!ALLOWED_FONT_IMPORT_HOSTS.has(url.hostname.toLowerCase())) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parseFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const tokens = splitFontFamily(trimmed);
  if (!tokens?.length) return undefined;
  if (!tokens.every(isSafeFontFamilyToken)) return undefined;
  return tokens.join(', ');
}

export function sanitizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'transparent') return trimmed;
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

export function sanitizeCssLength(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === '0') return trimmed;
  if (/^[0-9]+(?:\.[0-9]+)?(px|rem|em|%)$/.test(trimmed)) return trimmed;
  return undefined;
}

export function sanitizeFontWeight(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'normal' || trimmed === 'bold' || trimmed === 'bolder' || trimmed === 'lighter') {
    return trimmed;
  }
  if (/^[1-9]00$/.test(trimmed)) return trimmed;
  return undefined;
}

function splitFontFamily(value: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of value) {
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      current += char;
      continue;
    }

    if (char === quote) {
      quote = null;
      current += char;
      continue;
    }

    if (char === ',' && quote === null) {
      tokens.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (quote !== null) return null;
  tokens.push(current.trim());
  return tokens;
}

function isSafeFontFamilyToken(token: string): boolean {
  if (!token) return false;
  if (/<\//.test(token) || /[{};]|url\s*\(|expression\s*\(/i.test(token)) return false;

  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    const inner = token.slice(1, -1).trim();
    return Boolean(inner) && /^[A-Za-z0-9 _-]+$/.test(inner);
  }

  return /^[A-Za-z0-9 _-]+$/.test(token);
}
