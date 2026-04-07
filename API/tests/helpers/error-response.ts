import { expect } from 'vitest';

export function expectJsonError(
  body: unknown,
  options?: {
    code?: string;
    summary?: string | RegExp;
  },
): void {
  expect(body).toMatchObject({
    error: 'Request failed',
    code: options?.code ?? expect.any(String),
    summary: expect.any(String),
  });

  const parsed = body as {
    summary?: string;
    details?: unknown;
    hints?: unknown;
  };

  if (options?.summary) {
    if (typeof options.summary === 'string') {
      expect(parsed.summary).toContain(options.summary);
    } else {
      expect(parsed.summary).toMatch(options.summary);
    }
  }

  if ('details' in parsed && parsed.details !== undefined) {
    expect(Array.isArray(parsed.details)).toBe(true);
  }

  if ('hints' in parsed && parsed.hints !== undefined) {
    expect(Array.isArray(parsed.hints)).toBe(true);
  }
}
