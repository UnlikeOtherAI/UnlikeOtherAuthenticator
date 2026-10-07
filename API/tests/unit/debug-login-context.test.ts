import { describe, expect, it } from 'vitest';
import { debugLoginConfigIdentity } from '../../src/services/debug-login.service.js';

describe('debug login product environment binding', () => {
  it('accepts only supported presentation theme variants', () => {
    const canonical = 'https://api.example/api/auth/config';
    for (const theme of [
      'nessie', 'nebula', 'midnight', 'daylight', 'blckwhte', 'forest',
      'ocean', 'sunset', 'rose', 'graphite', 'sandstone', 'contrast',
    ]) {
      expect(debugLoginConfigIdentity(`${canonical}?theme=${theme}`)).toBe(canonical);
    }
    expect(() => debugLoginConfigIdentity(`${canonical}?theme=other`)).toThrow();
    expect(() => debugLoginConfigIdentity(`${canonical}?theme=nessie&theme=midnight`)).toThrow();
  });
  it('keeps the full origin, path and authority parameters', () => {
    const canonical = 'https://api.example/api/auth/config';
    for (const url of [
      'https://api.example:444/api/auth/config', 'https://other.example/api/auth/config',
      'https://api.example/other/config', `${canonical}?team=another`, `${canonical}?environment=dev`,
    ]) expect(debugLoginConfigIdentity(url)).not.toBe(canonical);
  });
});
